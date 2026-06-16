# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
# Activate the pnpm version pinned in package.json's "packageManager" field.
RUN corepack enable
WORKDIR /app

FROM base AS deps
# Manifest + lockfile + pnpm settings. pnpm-workspace.yaml carries `allowBuilds`
# which approves sharp's native build (blocked by default for supply-chain
# safety). scripts/ is needed because package.json's postinstall runs
# copy-guacamole.mjs during install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

FROM base AS build
# Client-visible env is baked at BUILD time (NEXT_PUBLIC_*). The browser dials
# WebSockets directly at NEXT_PUBLIC_BACKEND_WS_URL; the prod stack points it at
# the Caddy single-origin entrypoint. Changing the public host/port requires a
# rebuild — `deploy.sh/deploy.ps1 up|update` pass --build for exactly this reason.
ARG NEXT_PUBLIC_BACKEND_WS_URL
ARG NEXT_PUBLIC_APP_VERSION=docker
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_BACKEND_WS_URL=$NEXT_PUBLIC_BACKEND_WS_URL
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
RUN pnpm run build

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
EXPOSE 3000
CMD ["pnpm", "start"]
