# demo-shop — build context: repo root.
#   docker build -f services/demo-shop/Dockerfile -t plumberr-demo-shop .
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter=@plumberr/demo-shop \
 && pnpm --filter @plumberr/demo-shop deploy --prod --legacy /out

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 4100
CMD ["node", "dist/index.js"]
