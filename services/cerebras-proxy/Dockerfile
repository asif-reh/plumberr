# cerebras-proxy — build context: repo root.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter=@plumberr/cerebras-proxy \
 && pnpm --filter @plumberr/cerebras-proxy deploy --prod --legacy /out

FROM node:24-slim
ENV NODE_ENV=production CEREBRAS_PROXY_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 4300
CMD ["node", "dist/index.js"]
