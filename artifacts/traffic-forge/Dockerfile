# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json ./
COPY artifacts/traffic-forge/package.json artifacts/traffic-forge/
COPY lib/api-zod/package.json lib/api-zod/

RUN pnpm install --frozen-lockfile

COPY lib/api-zod lib/api-zod
COPY artifacts/traffic-forge artifacts/traffic-forge

RUN pnpm --filter traffic-forge-frontend run build

# ─── Runtime stage (nginx serving the static SPA) ─────────────────────────────
FROM nginx:1.27-alpine

# API URL injected at runtime via environment variable
ENV API_URL=http://localhost:8080

# Use nginx template mechanism — envsubst replaces $API_URL at container start
COPY artifacts/traffic-forge/nginx.conf.template /etc/nginx/templates/default.conf.template

COPY --from=builder /app/artifacts/traffic-forge/dist /usr/share/nginx/html

EXPOSE 80
