FROM node:24-bookworm-slim AS dependencies

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/workers/package.json packages/workers/package.json

RUN npm ci

FROM dependencies AS build

COPY prisma ./prisma
COPY packages/shared ./packages/shared
COPY packages/api ./packages/api

RUN npm run prisma:generate \
    && npm run build --workspace @distributed-rag/shared \
    && npm run build --workspace @distributed-rag/api

FROM build AS migrate

CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:24-bookworm-slim AS production-dependencies

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/workers/package.json packages/workers/package.json

RUN npm ci \
    --omit=dev \
    --workspace @distributed-rag/shared \
    --workspace @distributed-rag/api

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/api/package.json ./packages/api/package.json
COPY --from=build --chown=node:node /app/packages/api/dist ./packages/api/dist

USER node
EXPOSE 3000

CMD ["node", "packages/api/dist/server.js"]
