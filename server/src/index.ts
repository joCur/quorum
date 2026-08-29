export { buildApp } from "./app.js";
export type { BuildAppOptions } from "./app.js";
export { loadConfig } from "./config.js";
export type { ServerConfig } from "./config.js";
export { authPlugin } from "./auth/plugin.js";
export type { AuthPluginOptions } from "./auth/plugin.js";
export { hasRole } from "./auth/context.js";
export type { RequestContext } from "./auth/context.js";
export { AuthError } from "./auth/errors.js";
export type { AuthErrorCode } from "./auth/errors.js";
export {
  createKeycloakJwks,
  createTokenVerifier,
  extractBearerToken,
  keycloakJwksUri,
} from "./auth/token-verifier.js";
export type { TokenVerifier, TokenVerifierOptions } from "./auth/token-verifier.js";
