# api — build context: repo root.
#   docker build -f apps/api/Dockerfile -t plumberr-api .
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter=@plumberr/api \
 && pnpm --filter @plumberr/api deploy --prod --legacy /out

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
