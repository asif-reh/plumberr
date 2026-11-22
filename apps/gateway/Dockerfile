# Plumberr OpenClaw Gateway + plumberr-tools plugin. Build context: repo root.
#   docker build -f apps/gateway/Dockerfile -t plumberr-gateway .
# (Not built yet — Docker unavailable on the dev box; the same steps were verified natively via scripts/setup-gateway.sh.)
FROM node:24-slim AS plugin
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @plumberr/openclaw-tools --filter @plumberr/openclaw-hooks build \
 && (cd packages/openclaw-tools && pnpm pack --pack-destination /out) && mv /out/plumberr-openclaw-tools-*.tgz /out/plumberr-tools.tgz \
 && (cd packages/openclaw-hooks && pnpm pack --pack-destination /out) && mv /out/plumberr-openclaw-hooks-*.tgz /out/plumberr-hooks.tgz

FROM node:24-slim
RUN npm install -g openclaw@2026.11.6 --allow-scripts=openclaw
WORKDIR /app
COPY apps/gateway/openclaw.json5 apps/gateway/entrypoint.sh apps/gateway/render-config.mjs ./
COPY apps/gateway/workspace ./workspace
COPY --from=plugin /out/plumberr-tools.tgz /out/plumberr-hooks.tgz ./plugins/
ENV OPENCLAW_GATEWAY_PORT=8080 OPENCLAW_STATE_DIR=/data/.openclaw OPENCLAW_WORKSPACE_DIR=/data/workspace
EXPOSE 8080
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
