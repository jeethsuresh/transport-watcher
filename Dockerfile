# TTC Watcher — Next.js UI + Express API + Socket.IO + SQLite poller
#
# Build and run with Compose (project name: ttc-watcher):
#   docker compose build
#   docker compose up -d
#
# Or: ./build.sh && ./deploy.sh
#
# Run (persist DB on the host):
#   docker run --rm -p 3010:3010 \
#     -v ttc-watcher_ttc-data:/app/data \
#     -e SQLITE_PATH=/app/data/ttc-watcher.db \
#     ttc-watcher:latest

# -----------------------------------------------------------------------------
# 1. Install dependencies (cached while package-lock.json unchanged)
# -----------------------------------------------------------------------------
FROM node:22-bookworm AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

# -----------------------------------------------------------------------------
# 2. Build Next.js (.next/) and keep full node_modules (incl. devDeps for tsx)
# -----------------------------------------------------------------------------
FROM node:22-bookworm AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# -----------------------------------------------------------------------------
# 3. Runtime — slim image; reuse compiled node_modules from builder (no rebuild)
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user; /app/data is the default SQLite dir (override SQLITE_PATH if needed)
RUN groupadd --gid 1001 nodejs \
  && useradd --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin nodejs \
  && mkdir -p /app/data \
  && chown -R nodejs:nodejs /app

COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/.next ./.next
COPY --from=builder --chown=nodejs:nodejs /app/public ./public

COPY --from=builder --chown=nodejs:nodejs /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=nodejs:nodejs /app/server.ts /app/next.config.ts /app/tsconfig.json /app/next-env.d.ts ./
COPY --from=builder --chown=nodejs:nodejs /app/lib ./lib
COPY --from=builder --chown=nodejs:nodejs /app/app ./app
COPY --from=builder --chown=nodejs:nodejs /app/client ./client
COPY --from=builder --chown=nodejs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nodejs:nodejs /app/data ./data

USER nodejs

EXPOSE 3010

ENV PORT=3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3010/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./node_modules/.bin/tsx", "server.ts"]
