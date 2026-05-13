# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json ./
COPY artifacts/api-server/package.json artifacts/api-server/
COPY lib/db/package.json lib/db/
COPY lib/api-zod/package.json lib/api-zod/

RUN pnpm install --frozen-lockfile

COPY lib lib
COPY artifacts/api-server artifacts/api-server

RUN pnpm --filter @workspace/db exec tsc
RUN pnpm --filter @workspace/api-server run build

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.59.1-noble AS runtime

WORKDIR /app

COPY --from=builder /app/artifacts/api-server/dist ./dist

# Install all packages marked external in build.mjs that are actually used:
# - playwright + playwright-core (browser engine, externalized by esbuild)
# - @swc/helpers (externalized via @swc/* wildcard, required by pdfkit→fontkit)
# - bufferutil + utf-8-validate (optional ws perf deps)
RUN npm install \
    playwright@1.59.1 \
    playwright-core@1.59.1 \
    @swc/helpers \
    bufferutil \
    utf-8-validate \
    --no-save --ignore-scripts

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS "http://localhost:${PORT}/api/healthz" || exit 1

CMD ["node", "--enable-source-maps", "dist/index.mjs"]
