# Build from the REPO ROOT so the workspace packages are available:
#   docker build -f observability/collector/Dockerfile -t fc-obs-collector .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY observability/collector ./observability/collector
COPY examples/demo-consumer/package.json ./examples/demo-consumer/package.json
RUN pnpm install --frozen-lockfile --filter @frontier-commerce/obs-collector... \
 && pnpm --filter @frontier-commerce/sdk --filter @frontier-commerce/indexer build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/observability/collector/collector.mjs ./collector.mjs
COPY --from=build /repo/observability/collector/node_modules ./node_modules_local
# pnpm links workspace deps via symlinks under the package's node_modules;
# merge them so plain `node` resolves @frontier-commerce/* and pg.
RUN cp -r /app/node_modules_local/* /app/node_modules/ 2>/dev/null || true
VOLUME /data
CMD ["node", "collector.mjs"]
