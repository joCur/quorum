# Production image for @quorum/server.
#
# The build context is the repository root, because the server depends on the
# @quorum/shared workspace and on the root lockfile:
#   docker build -f server/Dockerfile .
#
# Stages:
#   base       — Node plus the pnpm version pinned in the root package.json
#   deps       — full install (dev dependencies included), for the TypeScript build
#   build      — compiles @quorum/shared and @quorum/server to dist/
#   prod-deps  — a second, production-only install, so no dev dependency is shipped
#   runtime    — lean image: manifests, production node_modules, compiled output

FROM node:22-alpine AS base
# Corepack reads the "packageManager" field of the root package.json, so the pnpm
# version is pinned in exactly one place.
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/

FROM base AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY shared/tsconfig.json ./shared/
COPY shared/src ./shared/src
COPY server/tsconfig.json ./server/
COPY server/src ./server/src
# Project references: building the server builds @quorum/shared first.
RUN pnpm --filter @quorum/server run build

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app

# Manifests and the production dependency tree, including the workspace symlink
# that resolves @quorum/shared.
COPY --from=prod-deps --chown=node:node /app ./
# Compiled JavaScript for both workspace packages.
COPY --from=build --chown=node:node /app/shared/dist ./shared/dist
COPY --from=build --chown=node:node /app/server/dist ./server/dist

# The node:* images ship an unprivileged "node" user; nothing here needs root.
USER node
EXPOSE 8080

# Compose and reverse proxies use the same probe the application exposes.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
