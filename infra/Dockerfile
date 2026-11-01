# One image with the server and the built web app. Build from the repository root:
#   docker build -f infra/Dockerfile -t mtg3d .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mtg3d/web build

# shortcut: the runtime image keeps the full workspace and dev dependencies (tsx runs the TypeScript directly); prune with `pnpm deploy` if image size matters.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production PORT=3001
EXPOSE 3001
USER node
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://localhost:3001/api/status').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
WORKDIR /app/apps/server
CMD ["node_modules/.bin/tsx", "src/main.ts"]
