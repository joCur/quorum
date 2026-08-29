/** Machine-readable reasons a request can fail authentication. */
export type AuthErrorCode =
  | "missing_token"
  | "malformed_authorization_header"
  | "malformed_bearer_subprotocol"
  | "invalid_token"
  | "expired_token"
  | "invalid_issuer"
  | "invalid_audience"
  | "missing_subject"
  | "missing_tenant";

/**
 * Authentication failure. The `message` is a developer-facing description in American English;
 * user-facing text is produced by the client through i18n, keyed by `code` (CLAUDE.md).
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly statusCode: number;

  constructor(code: AuthErrorCode, message: string, statusCode = 401) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
