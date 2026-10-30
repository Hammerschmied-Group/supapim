# One image for the plugin container: apps/server (MCP server at /cms/mcp, consent page, later the admin API)
# also serves apps/ui (static Vite build) under /cms.
# Build context = repo root; .dockerignore lets only apps/ in (never .env).

# ── apps/ui: static build. No project values are baked in; /cms/config.json supplies them at runtime.
FROM node:22-alpine AS ui
WORKDIR /ui
COPY apps/ui/package.json apps/ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/ui/index.html apps/ui/vite.config.js ./
COPY apps/ui/src ./src
RUN npx vite build

FROM node:22-alpine
# Release metadata (scripts/build-image.sh passes these; the version comes from the root package.json)
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="supapim" \
      org.opencontainers.image.description="SupaPIM: schema-first CMS/PIM UI, remote MCP server and admin API for Supabase (one image)" \
      org.opencontainers.image.source="https://github.com/hammerschmied-group/supapim" \
      org.opencontainers.image.url="https://automatethis.pro" \
      org.opencontainers.image.vendor="AutomateThis! (Hammerschmied Sp. z o.o.)" \
      org.opencontainers.image.licenses="BUSL-1.1" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
ENV NODE_ENV=production
ENV CMS_VERSION=${VERSION}
COPY apps/server/package.json apps/server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY apps/server/*.mjs ./
COPY apps/server/public ./public
COPY apps/server/src ./src
COPY --from=ui /ui/dist ./ui
ENV CMS_UI_DIR=/app/ui
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
