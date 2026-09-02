/**
 * Giving a freshly registered account a tenant.
 *
 * WHY THIS EXISTS AT ALL. Every data object in Quorum is tenant-scoped from day one (ADR-001), and
 * the access token has to carry the tenant as a claim — a request whose token has none is refused
 * with 403 rather than falling back to something global. Self-registration therefore creates a
 * user Keycloak is perfectly happy with and this API cannot serve: the account exists, the password
 * works, the token is signed, and every endpoint says no.
 *
 * Keycloak cannot close that gap on its own. It has no way to compute a per-user attribute at
 * registration time: the declarative user profile has no defaults, a protocol mapper reads
 * attributes but cannot invent one, and two mappers writing the same claim have no defined order,
 * so "attribute if present, else the user id" is not expressible. The options that remain are a
 * registration-time SPI in Java — a second language, its own build, pinned to an admin API that
 * changes between majors — or filling the attribute in from here. This is the second one.
 *
 * WHAT IT DOES. On the first request a tenant-less account makes, the API writes a `tenant_id`
 * attribute onto the Keycloak user through the admin API, using a service account that holds
 * exactly one realm-management role. The next token the client obtains carries the claim, and from
 * then on the account is indistinguishable from one an administrator created by hand. Nothing
 * about the token contract changes: `tenant_id` stays mandatory, and an unprovisioned user still
 * cannot see a single row.
 *
 * WHY THE TENANT ID IS DERIVED FROM THE USER ID. Each self-registration gets its own tenant, so
 * the first value is `tenant-<user id>` rather than a fresh random one. That makes provisioning
 * genuinely idempotent: two sign-ins racing on two devices compute the same value, so there is no
 * window in which the same account exists under two tenants. It is a starting value, not an
 * identity — the attribute is ordinary data, so moving a user into a shared tenant later is an
 * attribute change and nothing else. That is the whole reason this is an attribute rather than a
 * protocol mapper reading `sub` directly: a mapper would make one-user-per-tenant permanent, and
 * the `quorum-admin` role already promises tenants with more than one member in them.
 */

/** Writes the tenant of a user who has none yet, and answers with the tenant either way. */
export interface TenantProvisioner {
  /**
   * Ensures the user has a tenant and returns it. Idempotent: called for a user who already has
   * one, it returns that one and writes nothing.
   */
  ensureTenant(userId: string): Promise<string>;
}

/** Raised when the provider refuses or cannot be reached. Surfaces as a 503, never as a 500. */
export class ProvisioningError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProvisioningError";
  }
}

export interface KeycloakTenantProvisionerOptions {
  /** Base URL of the Keycloak server, without the realm path — inside compose, the internal one. */
  readonly baseUrl: string;
  readonly realm: string;
  /** Confidential client with the `manage-users` realm-management role. */
  readonly clientId: string;
  readonly clientSecret: string;
  /** User attribute the tenant is stored in. Matches the token's tenant claim. */
  readonly attribute?: string;
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected in tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface KeycloakUser {
  readonly id?: string;
  readonly attributes?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

/** The tenant a user with none gets: their own, named after them. */
export function derivedTenantId(userId: string): string {
  return `tenant-${userId}`;
}

export class KeycloakTenantProvisioner implements TenantProvisioner {
  readonly #options: Required<Pick<KeycloakTenantProvisionerOptions, "attribute">> &
    KeycloakTenantProvisionerOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  /**
   * One in-flight call per user. Two requests from the same account arriving together would
   * otherwise both read "no tenant" and both write; they would write the same value, so the
   * outcome is the same either way, but there is no reason to ask the provider twice.
   */
  readonly #inFlight = new Map<string, Promise<string>>();
  #token: { value: string; expiresAt: number } | undefined;

  constructor(options: KeycloakTenantProvisionerOptions) {
    this.#options = { attribute: "tenant_id", ...options };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async ensureTenant(userId: string): Promise<string> {
    const running = this.#inFlight.get(userId);
    if (running) return running;

    const attempt = this.#ensure(userId).finally(() => this.#inFlight.delete(userId));
    this.#inFlight.set(userId, attempt);
    return attempt;
  }

  async #ensure(userId: string): Promise<string> {
    const user = await this.#getUser(userId);

    const existing = readAttribute(user.attributes, this.#options.attribute);
    if (existing !== undefined) return existing;

    const tenantId = derivedTenantId(userId);
    // The whole representation goes back, with the attributes merged rather than replaced: a PUT
    // carrying only `attributes` would drop everything else the admin API considers writable.
    await this.#putUser(userId, {
      ...user,
      attributes: { ...user.attributes, [this.#options.attribute]: [tenantId] },
    });
    return tenantId;
  }

  async #getUser(userId: string): Promise<KeycloakUser> {
    const response = await this.#admin(`users/${encodeURIComponent(userId)}`);
    if (!response.ok) {
      throw new ProvisioningError(
        `The identity provider did not return user ${userId} (${response.status}).`,
      );
    }
    return (await response.json()) as KeycloakUser;
  }

  async #putUser(userId: string, user: KeycloakUser): Promise<void> {
    const response = await this.#admin(`users/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify(user),
    });
    if (!response.ok) {
      throw new ProvisioningError(
        `The identity provider refused the tenant attribute for user ${userId} (${response.status}).`,
      );
    }
  }

  async #admin(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.#serviceAccountToken();
    const url = `${trimSlash(this.#options.baseUrl)}/admin/realms/${encodeURIComponent(this.#options.realm)}/${path}`;
    try {
      return await this.#fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      });
    } catch (error) {
      throw new ProvisioningError("The identity provider could not be reached.", { cause: error });
    }
  }

  /**
   * The service account's own access token, cached until shortly before it expires. Shortly, not
   * exactly: a token that expires while in flight fails a request that had nothing wrong with it.
   */
  async #serviceAccountToken(): Promise<string> {
    const cached = this.#token;
    if (cached && cached.expiresAt > this.#now()) return cached.value;

    const url = `${trimSlash(this.#options.baseUrl)}/realms/${encodeURIComponent(this.#options.realm)}/protocol/openid-connect/token`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.#options.clientId,
          client_secret: this.#options.clientSecret,
        }),
      });
    } catch (error) {
      throw new ProvisioningError("The identity provider could not be reached.", { cause: error });
    }

    if (!response.ok) {
      // Deliberately without the body: it is the one place a wrong client secret would be echoed.
      throw new ProvisioningError(
        `The identity provider refused the provisioning client (${response.status}).`,
      );
    }

    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") {
      throw new ProvisioningError("The identity provider returned no access token.");
    }
    const lifetime = typeof body.expires_in === "number" ? body.expires_in : 60;
    this.#token = {
      value: body.access_token,
      expiresAt: this.#now() + Math.max(lifetime - 30, 5) * 1000,
    };
    return body.access_token;
  }
}

function readAttribute(
  attributes: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const value = attributes?.[name];
  // Keycloak stores every user attribute as an array of strings, but hand-written fixtures and
  // older exports carry the bare string, so both shapes are accepted on the way in.
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
