# syntax=docker/dockerfile:1
ARG K6_VERSION=2.3.0
ARG BUN_VERSION=1.4.3-alpine

FROM grafana/k6:${K6_VERSION} AS k6

# --- panel (React + Vite) ---
FROM oven/bun:${BUN_VERSION} AS web
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

# --- server dependencies ---
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app/server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production

# --- runtime image: Bun runs TypeScript directly, no build step ---
FROM oven/bun:${BUN_VERSION}
# BROWSER=true adds Chromium (about 1 GB) for browser workflows; workers without it skip browser runs
ARG BROWSER=false
RUN apk add --no-cache tini ca-certificates tzdata \
 && if [ "$BROWSER" = "true" ]; then apk add --no-cache chromium font-noto; fi
COPY --from=k6 /usr/bin/k6 /usr/bin/k6
WORKDIR /app/server
COPY --from=deps /app/server/node_modules ./node_modules
COPY server/package.json server/tsconfig.json ./
COPY server/src ./src
COPY server/k6 ./k6
COPY server/migrations ./migrations
COPY --from=web /app/web/dist /app/web/dist
RUN mkdir -p /tmp/loadlab && chown bun:bun /tmp/loadlab
ENV NODE_ENV=production \
    K6_BIN=/usr/bin/k6 \
    WEB_DIST=/app/web/dist \
    WORK_DIR=/tmp/loadlab \
    K6_NO_USAGE_REPORT=true
USER bun
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "src/api.ts"]
