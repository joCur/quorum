import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  SUMMARY_SCHEMA_VERSION,
  SummaryTemplateSchema,
  SYSTEM_TEMPLATE_ID,
  type SummaryTemplate,
  type SummaryTemplateDraft,
  type SummaryTemplateView,
} from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import { InMemorySummaryTemplateStore } from "../src/templates/memory.js";
import { AUDIENCE, INTERNAL_ISSUER, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";

const keys: TestKeyPair = await createTestKeyPair();

const ACME = { tenantId: "tenant-acme", userId: "user-1" };
const ACME_OTHER_USER = { tenantId: "tenant-acme", userId: "user-2" };
const GLOBEX = { tenantId: "tenant-globex", userId: "user-9" };

/**
 * Stand-in for the template the worker seeds. The server does not own its content — it only has
 * to treat it as the read-only base everybody inherits from.
 */
const SYSTEM_TEMPLATE: SummaryTemplate = SummaryTemplateSchema.parse({
  id: SYSTEM_TEMPLATE_ID,
  schemaVersion: SUMMARY_SCHEMA_VERSION,
  name: "Standard meeting summary",
  version: 1,
  scope: "system",
  basedOn: null,
  sections: [
    { id: "overview", title: "Overview", instruction: "What happened.", format: "prose" },
    { id: "decisions", title: "Decisions", instruction: "What was settled.", format: "bullets" },
  ],
  overrides: [],
  options: {},
});

const RISKS = {
  id: "risks",
  title: "Risks",
  instruction: "Named risks only.",
  format: "bullets" as const,
};

function draft(overrides: Partial<SummaryTemplateDraft> = {}): Record<string, unknown> {
  return {
    name: "My layout",
    overrides: [{ sectionId: "risks", action: "add", section: RISKS }],
    ...overrides,
  };
}

let app: FastifyInstance;
let templates: InMemorySummaryTemplateStore;

async function token(scope: { tenantId: string; userId: string }): Promise<string> {
  return signAccessToken(keys, {
    subject: scope.userId,
    tenantId: scope.tenantId,
    roles: ["quorum-user"],
  });
}

async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  scope: { tenantId: string; userId: string },
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await token(scope)}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

beforeAll(async () => {
  templates = new InMemorySummaryTemplateStore();
  templates.seedSystemTemplate(SYSTEM_TEMPLATE);

  app = await buildServer({
    storage: new InMemoryRecordingStorage(),
    queue: new InMemoryJobQueue(),
    meetings: new InMemoryMeetingStore(),
    templates,
    auth: {
      verifyAccessToken: createTokenVerifier({
        issuers: [INTERNAL_ISSUER, ISSUER],
        audience: AUDIENCE,
        tenantClaim: "tenant_id",
        keySource: keys.jwks,
      }),
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("an instance built without a template store", () => {
  /**
   * There is no in-memory fallback on purpose. A default store would answer with an empty list
   * and no system template — a shape production never has — so a test written against it would
   * be testing a fiction. Without a store the endpoints simply do not exist.
   */
  it("serves neither the template API nor the regenerate action", async () => {
    const bare = await buildServer({
      storage: new InMemoryRecordingStorage(),
      queue: new InMemoryJobQueue(),
      meetings: new InMemoryMeetingStore(),
      auth: {
        verifyAccessToken: createTokenVerifier({
          issuers: [INTERNAL_ISSUER, ISSUER],
          audience: AUDIENCE,
          tenantClaim: "tenant_id",
          keySource: keys.jwks,
        }),
      },
    });
    await bare.ready();
    try {
      const authorization = `Bearer ${await token(ACME)}`;
      const list = await bare.inject({
        method: "GET",
        url: "/api/summary-templates",
        headers: { authorization },
      });
      expect(list.statusCode).toBe(404);

      const regenerate = await bare.inject({
        method: "POST",
        url: `/api/meetings/${SYSTEM_TEMPLATE_ID}/summaries`,
        headers: { authorization },
        payload: {},
      });
      expect(regenerate.statusCode).toBe(404);

      // The meeting API is unaffected — it has its own store and its own reason to exist.
      const meetings = await bare.inject({
        method: "GET",
        url: "/api/meetings",
        headers: { authorization },
      });
      expect(meetings.statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });
});

describe("template list", () => {
  it("requires an access token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/summary-templates" });
    expect(response.statusCode).toBe(401);
  });

  it("shows the system template to everyone, marked as not editable", async () => {
    const response = await call("GET", "/api/summary-templates", GLOBEX);
    expect(response.statusCode).toBe(200);
    const { templates: views } = response.json() as { templates: SummaryTemplateView[] };
    expect(views).toHaveLength(1);
    expect(views[0]!.template.id).toBe(SYSTEM_TEMPLATE_ID);
    expect(views[0]!.editable).toBe(false);
    expect(views[0]!.resolvedSections.map((section) => section.id)).toEqual([
      "overview",
      "decisions",
    ]);
  });
});

describe("creating a template", () => {
  it("inherits from the system template by default and resolves the overrides", async () => {
    const response = await call("POST", "/api/summary-templates", ACME, draft());
    expect(response.statusCode).toBe(201);

    const view = response.json() as SummaryTemplateView;
    expect(view.template.scope).toBe("user");
    expect(view.template.version).toBe(1);
    expect(view.template.basedOn).toBe(SYSTEM_TEMPLATE_ID);
    expect(view.editable).toBe(true);
    // The base's sections come through live; the override lands after them.
    expect(view.resolvedSections.map((section) => section.id)).toEqual([
      "overview",
      "decisions",
      "risks",
    ]);
  });

  it("refuses a template whose overrides leave nothing to write", async () => {
    const response = await call(
      "POST",
      "/api/summary-templates",
      ACME,
      draft({
        overrides: [
          { sectionId: "overview", action: "hide", section: null },
          { sectionId: "decisions", action: "hide", section: null },
        ],
      }),
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_template" });
  });

  it("refuses a chain longer than one level of inheritance", async () => {
    const parent = await call("POST", "/api/summary-templates", ACME, draft());
    const parentId = (parent.json() as SummaryTemplateView).template.id;

    const response = await call(
      "POST",
      "/api/summary-templates",
      ACME,
      draft({ name: "Grandchild", basedOn: parentId }),
    );
    expect(response.statusCode).toBe(400);
  });

  it("refuses a base the caller cannot see", async () => {
    const mine = await call("POST", "/api/summary-templates", ACME, draft());
    const mineId = (mine.json() as SummaryTemplateView).template.id;

    const response = await call(
      "POST",
      "/api/summary-templates",
      GLOBEX,
      draft({ basedOn: mineId }),
    );
    expect(response.statusCode).toBe(400);
  });

  it("carries the chosen output language into the stored options", async () => {
    const response = await call(
      "POST",
      "/api/summary-templates",
      ACME,
      draft({ options: { tone: "formal", length: "brief", outputLanguage: "de" } }),
    );
    expect(response.statusCode).toBe(201);
    expect((response.json() as SummaryTemplateView).template.options).toEqual({
      tone: "formal",
      length: "brief",
      outputLanguage: "de",
    });
  });

  it("defaults the output language to `auto`, i.e. follow the recording", async () => {
    const response = await call("POST", "/api/summary-templates", ACME, draft());
    expect((response.json() as SummaryTemplateView).template.options.outputLanguage).toBe("auto");
  });
});

describe("scoping (ADR-001)", () => {
  let owned: string;

  beforeAll(async () => {
    const created = await call("POST", "/api/summary-templates", ACME, draft({ name: "Private" }));
    owned = (created.json() as SummaryTemplateView).template.id;
  });

  it("keeps a template out of another tenant's list", async () => {
    const response = await call("GET", "/api/summary-templates", GLOBEX);
    const ids = (response.json() as { templates: SummaryTemplateView[] }).templates.map(
      (view) => view.template.id,
    );
    expect(ids).not.toContain(owned);
  });

  it("keeps a template out of another user's list inside the same tenant", async () => {
    const response = await call("GET", "/api/summary-templates", ACME_OTHER_USER);
    const ids = (response.json() as { templates: SummaryTemplateView[] }).templates.map(
      (view) => view.template.id,
    );
    expect(ids).not.toContain(owned);
  });

  it("answers a cross-tenant read with 404, never 403", async () => {
    const response = await call("GET", `/api/summary-templates/${owned}`, GLOBEX);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "template_not_found" });
  });

  it("answers a cross-user write with 404", async () => {
    const response = await call(
      "PUT",
      `/api/summary-templates/${owned}`,
      ACME_OTHER_USER,
      draft({ name: "Stolen" }),
    );
    expect(response.statusCode).toBe(404);
  });

  it("answers a cross-user delete with 404 and leaves the template alone", async () => {
    const response = await call("DELETE", `/api/summary-templates/${owned}`, ACME_OTHER_USER);
    expect(response.statusCode).toBe(404);
    expect((await call("GET", `/api/summary-templates/${owned}`, ACME)).statusCode).toBe(200);
  });

  it("answers a malformed id with 404 rather than a validation error", async () => {
    const response = await call("GET", "/api/summary-templates/not-a-uuid", ACME);
    expect(response.statusCode).toBe(404);
  });
});

describe("editing a template", () => {
  it("stores an edit as a new version and leaves the old one readable", async () => {
    const created = await call("POST", "/api/summary-templates", ACME, draft({ name: "V1" }));
    const id = (created.json() as SummaryTemplateView).template.id;

    const updated = await call(
      "PUT",
      `/api/summary-templates/${id}`,
      ACME,
      draft({ name: "V2", overrides: [{ sectionId: "overview", action: "hide", section: null }] }),
    );
    expect(updated.statusCode).toBe(200);
    const view = updated.json() as SummaryTemplateView;
    expect(view.template.version).toBe(2);
    expect(view.template.name).toBe("V2");
    expect(view.resolvedSections.map((section) => section.id)).toEqual(["decisions"]);

    // The list shows the highest version, not both.
    const read = await call("GET", `/api/summary-templates/${id}`, ACME);
    expect((read.json() as SummaryTemplateView).template.version).toBe(2);
  });

  it("refuses to edit the system template, the same way as a template that is not yours", async () => {
    const response = await call(
      "PUT",
      `/api/summary-templates/${SYSTEM_TEMPLATE_ID}`,
      ACME,
      draft(),
    );
    expect(response.statusCode).toBe(404);
  });

  it("refuses a body that is not a template at all", async () => {
    const created = await call("POST", "/api/summary-templates", ACME, draft());
    const id = (created.json() as SummaryTemplateView).template.id;

    const response = await call("PUT", `/api/summary-templates/${id}`, ACME, { name: "" });
    expect(response.statusCode).toBe(400);
  });
});

describe("deleting a template", () => {
  it("removes every version and answers a second attempt with 404", async () => {
    const created = await call("POST", "/api/summary-templates", ACME, draft({ name: "Doomed" }));
    const id = (created.json() as SummaryTemplateView).template.id;
    await call("PUT", `/api/summary-templates/${id}`, ACME, draft({ name: "Doomed v2" }));

    expect((await call("DELETE", `/api/summary-templates/${id}`, ACME)).statusCode).toBe(204);
    expect((await call("DELETE", `/api/summary-templates/${id}`, ACME)).statusCode).toBe(404);
    expect((await call("GET", `/api/summary-templates/${id}`, ACME)).statusCode).toBe(404);
  });

  it("refuses to delete the system template", async () => {
    const response = await call("DELETE", `/api/summary-templates/${SYSTEM_TEMPLATE_ID}`, ACME);
    expect(response.statusCode).toBe(404);
  });
});

describe("the default template", () => {
  /** The templates the caller sees, keyed by id, so an assertion can name one. */
  async function listed(scope: {
    tenantId: string;
    userId: string;
  }): Promise<Map<string, SummaryTemplateView>> {
    const response = await call("GET", "/api/summary-templates", scope);
    const body = response.json() as { templates: SummaryTemplateView[] };
    return new Map(body.templates.map((view) => [view.template.id, view]));
  }

  async function create(
    scope: { tenantId: string; userId: string },
    name: string,
  ): Promise<string> {
    const created = await call("POST", "/api/summary-templates", scope, draft({ name }));
    return (created.json() as SummaryTemplateView).template.id;
  }

  it("marks the system template until the user chooses one of their own", async () => {
    const id = await create(ACME, "Not chosen yet");
    const before = await listed(ACME);

    expect(before.get(SYSTEM_TEMPLATE_ID)?.isDefault).toBe(true);
    expect(before.get(id)?.isDefault).toBe(false);

    await call("DELETE", `/api/summary-templates/${id}`, ACME);
  });

  it("moves the mark to the chosen template and gives it back when it is unset", async () => {
    const id = await create(ACME, "Chosen");

    expect((await call("PUT", `/api/summary-templates/${id}/default`, ACME)).statusCode).toBe(204);
    const chosen = await listed(ACME);
    expect(chosen.get(id)?.isDefault).toBe(true);
    // Exactly one template is ever marked — the system one steps aside.
    expect(chosen.get(SYSTEM_TEMPLATE_ID)?.isDefault).toBe(false);

    expect((await call("DELETE", "/api/summary-templates/default", ACME)).statusCode).toBe(204);
    const released = await listed(ACME);
    expect(released.get(id)?.isDefault).toBe(false);
    expect(released.get(SYSTEM_TEMPLATE_ID)?.isDefault).toBe(true);

    await call("DELETE", `/api/summary-templates/${id}`, ACME);
  });

  /**
   * The point of the fallback: a user who deletes the template they summarize with keeps getting
   * summaries — made with the system template — rather than a pipeline pointing at nothing.
   */
  it("falls back to the system template when the chosen one is deleted", async () => {
    const id = await create(ACME, "Deleted while default");
    await call("PUT", `/api/summary-templates/${id}/default`, ACME);

    expect((await call("DELETE", `/api/summary-templates/${id}`, ACME)).statusCode).toBe(204);

    const after = await listed(ACME);
    expect(after.has(id)).toBe(false);
    expect(after.get(SYSTEM_TEMPLATE_ID)?.isDefault).toBe(true);
  });

  it("refuses the system template as a choice, because that is what no choice means", async () => {
    const response = await call(
      "PUT",
      `/api/summary-templates/${SYSTEM_TEMPLATE_ID}/default`,
      ACME,
    );
    expect(response.statusCode).toBe(404);
  });

  /** ADR-001 again: another user's template id must not be storable as this user's choice. */
  it("cannot be pointed at a template belonging to somebody else", async () => {
    const foreign = await create(GLOBEX, "Not yours");

    const response = await call("PUT", `/api/summary-templates/${foreign}/default`, ACME);
    expect(response.statusCode).toBe(404);
    expect((await listed(ACME)).get(SYSTEM_TEMPLATE_ID)?.isDefault).toBe(true);

    await call("DELETE", `/api/summary-templates/${foreign}`, GLOBEX);
  });

  it("is one user's choice, not the whole tenant's", async () => {
    const mine = await create(ACME, "Mine only");
    await call("PUT", `/api/summary-templates/${mine}/default`, ACME);

    const colleague = await listed(ACME_OTHER_USER);
    expect(colleague.has(mine)).toBe(false);
    expect(colleague.get(SYSTEM_TEMPLATE_ID)?.isDefault).toBe(true);

    await call("DELETE", "/api/summary-templates/default", ACME);
    await call("DELETE", `/api/summary-templates/${mine}`, ACME);
  });

  it("answers unsetting a choice that was never made with the same 204", async () => {
    expect((await call("DELETE", "/api/summary-templates/default", ACME)).statusCode).toBe(204);
  });
});
