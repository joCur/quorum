import { UnauthorizedError } from "./context-provider.js";
import type {
  RecordingContext,
  RecordingContextProvider,
  RecordingContextRequest,
} from "./types.js";

/**
 * Production context provider: the recording scope is whatever the auth plugin derived from the
 * validated access token, and nothing else.
 *
 * The plugin's default-deny hook has already rejected an upgrade without a valid token by the
 * time this runs, so a missing context means the endpoint was mounted without the auth plugin —
 * a wiring mistake, refused rather than papered over.
 */
export class JwtRecordingContextProvider implements RecordingContextProvider {
  async resolve(request: RecordingContextRequest): Promise<RecordingContext> {
    const auth = request.auth;
    if (auth === undefined) {
      throw new UnauthorizedError("no authenticated request context on the recording upgrade");
    }
    return { tenantId: auth.tenantId, userId: auth.userId };
  }
}
