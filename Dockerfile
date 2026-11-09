# Stribog: the web app and its API in one container.
# Notes, history and agent tokens live in /data; the config (with the router's address) in /config.

FROM node:26-bookworm-slim AS base
RUN npm install --global --no-fund --no-audit pnpm@9.15.4
WORKDIR /app
COPY package.json pnpm-lock.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod

FROM node:26-bookworm-slim
WORKDIR /app
ARG REVISION=dev
LABEL org.opencontainers.image.title="Stribog" org.opencontainers.image.revision=$REVISION
# A container cannot see the home network's gateway, so the router's address comes from the config.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4517 STRIBOG_DATA=/data STRIBOG_CONFIG=/config/stribog.config.json STRIBOG_REVISION=$REVISION
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY fixtures/demo ./fixtures/demo
COPY --from=build /app/dist ./dist
RUN mkdir /data /config && chown node:node /data
USER node
EXPOSE 4517
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4517/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--import", "tsx", "src/server/server.ts"]
