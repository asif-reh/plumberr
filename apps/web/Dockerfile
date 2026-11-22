# web — build context: repo root.
FROM node:24-slim
RUN corepack enable
WORKDIR /repo
COPY . .
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm install --frozen-lockfile && pnpm turbo run build --filter=@plumberr/web
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
WORKDIR /repo/apps/web
CMD ["sh","-c","exec node_modules/.bin/next start -p ${PORT:-3000}"]
