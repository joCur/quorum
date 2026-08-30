# Production image for @quorum/client — the PWA, plus the nginx that serves and routes it.
#
# The build context is the repository root, because the client depends on the @quorum/shared
# workspace and on the root lockfile:
#   docker build -f client/Dockerfile .
#
# Stages:
#   base    — Node plus the pnpm version pinned in the root package.json
#   deps    — full install, for the Vite build
#   build   — compiles @quorum/shared and builds the PWA to client/dist
#   runtime — unprivileged nginx serving those files and proxying the API and Keycloak
#
# RUNTIME CONFIGURATION, AND WHY THERE IS NONE TO SPEAK OF: Vite bakes VITE_* values into the
# bundle at build time, so a published image cannot carry a deployment's own API origin or issuer
# URL. Rather than injecting a config file at container start — which means shipping an app that
# reads its configuration from a global written by an entrypoint, and a window during startup when
# it is not yet there — this image is built for the shape the app already assumes: everything on
# one origin. VITE_API_BASE_URL stays empty, so API calls are same-origin, and the OIDC issuer
# defaults to <origin>/realms/quorum. The edge proxy in the release stack is what makes that true.
#
# This image itself serves static files and nothing more. It names no other service and runs
# standalone.
#
# The consequence is worth stating plainly: a deployment that wants Keycloak on a DIFFERENT public
# host, or the realm under a different path, cannot use the published image as-is. It sets
# VITE_OIDC_ISSUER_URL (or VITE_OIDC_ISSUER_PATH) and builds its own — one `docker build` with
# --build-arg. See docs/deployment.md.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY client/package.json ./client/

FROM base AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY shared/tsconfig.json ./shared/
COPY shared/src ./shared/src
COPY client/tsconfig.json client/vite.config.ts ./client/
COPY client/index.html client/postcss.config.js client/tailwind.config.ts ./client/
COPY client/public ./client/public
COPY client/src ./client/src

# Same-origin defaults, stated explicitly rather than left to chance: an empty API base URL and an
# empty issuer URL are what make the app resolve both against its own origin at runtime. They are
# build args so a deployment needing a different shape can override them without editing anything.
ARG VITE_API_BASE_URL=""
ARG VITE_OIDC_ISSUER_URL=""
ARG VITE_OIDC_ISSUER_PATH="/realms/quorum"
ARG VITE_OIDC_CLIENT_ID="quorum-pwa"
ARG VITE_OIDC_SCOPE="openid profile email"
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_OIDC_ISSUER_URL=$VITE_OIDC_ISSUER_URL \
    VITE_OIDC_ISSUER_PATH=$VITE_OIDC_ISSUER_PATH \
    VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID \
    VITE_OIDC_SCOPE=$VITE_OIDC_SCOPE

RUN pnpm --filter @quorum/client run build

# nginx-unprivileged rather than the stock nginx image: it already runs as a non-root user and
# listens on 8080, instead of starting as root to bind port 80 and dropping privileges afterwards.
# That is what makes `cap_drop: ALL` in the compose file uneventful.
FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime

# The finished server config, replacing the base image's default. No envsubst template: there is
# nothing to substitute, and shipping one would require a writable /etc/nginx/conf.d at runtime.
COPY --chown=nginx:nginx client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /app/client/dist /usr/share/nginx/html

USER nginx
EXPOSE 8080

# Asks nginx whether it is serving the app. Nothing else is this container's business.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
    CMD wget --spider -q http://127.0.0.1:8080/healthz/client || exit 1

CMD ["nginx", "-g", "daemon off;"]
