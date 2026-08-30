# @quorum/client

The Quorum PWA: the recording flow, crash-safe local buffering, and the meeting, transcript and
summary screens. React + Vite, configured entirely through `VITE_*` build-time variables so a
self-hosted deployment can point the app at its own API and identity provider.

## Same-origin by design

A deployment serves the PWA and the API from one origin behind a single reverse proxy. The app
therefore makes same-origin requests, `VITE_API_BASE_URL` stays empty, and the API needs no CORS
headers at all — the simplest and safest production stance.

Development has to reproduce that shape rather than work around it. The dev server listens on
port 5173 while the API listens on 8080, so the dev server proxies the paths the API owns:

| Path       | Forwarded to                       | Notes                                          |
| ---------- | ---------------------------------- | ---------------------------------------------- |
| `/api`     | `http://localhost:8080` | REST endpoints                                  |
| `/ws`      | `http://localhost:8080` | Recording WebSocket, proxied with `ws: true`     |
| `/healthz` | `http://localhost:8080` | Reports the API's readiness, not the dev server's |

`/ws` is not optional. Without it the handshake fails while REST keeps working, which shows up as
a permanently offline connection banner on an otherwise healthy app.

Override the target when the API runs somewhere other than `localhost:8080`:

```bash
QUORUM_DEV_API_TARGET=http://192.168.1.20:8080 pnpm run dev:client
```

`vite preview` is a bare static server and does not read this variable; it proxies `/api` and
`/ws` only when `QUORUM_PREVIEW_API_TARGET` is set, which is how the end-to-end suite runs the
built app against a real API.

## Local development

1. Bring up the stack (API, Postgres, MinIO, Keycloak):

   ```bash
   docker compose up -d
   ```

2. Create the frontend configuration once:

   ```bash
   cp client/.env.example client/.env.local
   ```

   Leave `VITE_API_BASE_URL` empty — the dev proxy above is what makes that work. Point
   `VITE_OIDC_ISSUER_URL` at the Keycloak realm as reachable from the browser.

3. Start the dev server:

   ```bash
   pnpm run dev:client
   ```

   The app is at http://localhost:5173 and signs in against the dev realm; the test users are
   documented in `infra/keycloak/README.md`.

Setting `VITE_API_BASE_URL` to an absolute origin is a supported deployment configuration, but in
development it bypasses the proxy and lands on CORS errors. Prefer the empty value.

## Runtime assets

Fonts ship as WOFF2 from `@fontsource` and icons come from `lucide-react`, all bundled. The app
makes no CDN requests at runtime, which a self-hosted deployment depends on.
