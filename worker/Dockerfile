# Production image for @quorum/worker.
#
# The build context is the repository root, because the worker depends on the
# @quorum/shared workspace and on the root lockfile:
#   docker build -f worker/Dockerfile .
#
# Stages:
#   base       — Node plus the pnpm version pinned in the root package.json
#   deps       — full install (dev dependencies included), for the TypeScript build
#   build      — compiles @quorum/shared and @quorum/worker to dist/
#   prod-deps  — a second, production-only install, so no dev dependency is shipped
#   runtime    — lean image: manifests, production node_modules, compiled output

FROM node:22-alpine AS base
# Corepack reads the "packageManager" field of the root package.json, so the pnpm
# version is pinned in exactly one place.
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY worker/package.json ./worker/

FROM base AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY shared/tsconfig.json ./shared/
COPY shared/src ./shared/src
COPY worker/tsconfig.json ./worker/
COPY worker/src ./worker/src
# Project references: building the worker builds @quorum/shared first.
RUN pnpm --filter @quorum/worker run build

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Manifests and the production dependency tree, including the workspace symlink
# that resolves @quorum/shared.
COPY --from=prod-deps --chown=node:node /app ./
# Compiled JavaScript for both workspace packages.
COPY --from=build --chown=node:node /app/shared/dist ./shared/dist
COPY --from=build --chown=node:node /app/worker/dist ./worker/dist

# The node:* images ship an unprivileged "node" user; nothing here needs root.
USER node

# No port and no HTTP probe: the worker is a queue consumer, not a server. Its
# liveness is the pg-boss connection, and the process exits when that fails, so
# the restart policy is what supervises it.
CMD ["node", "worker/dist/index.js"]
