# AgenticFocus MCP Server — Production Dockerfile
# Story 25-3 / Sprint 24 / Epic 25
#
# Multi-stage build for minimal image size + reproducible deps.
# Final image : node:20-alpine + dist/ + production deps + non-root user.

# ─── Stage 1 : builder ──────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files first to leverage Docker layer caching
COPY package.json package-lock.json ./

# Install ALL deps (incl. dev) for the TypeScript build
RUN npm install --no-audit --no-fund

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Compile TS → dist/
RUN npm run build

# ─── Stage 2 : runtime ──────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# wget is required for the HEALTHCHECK (alpine doesn't ship curl by default)
RUN apk add --no-cache wget

WORKDIR /app

# Copy package files (for prod install)
COPY package.json package-lock.json ./

# Install ONLY production deps — tsx, vitest, typescript stay out
RUN npm install --omit=dev --no-audit --no-fund && \
    npm cache clean --force

# Copy compiled JS from builder stage
COPY --from=builder /app/dist ./dist

# Stockage des jetons d'agent (Story 27-10) : dossier appartenant à l'utilisateur non-root, à monter en volume
# (un volume nommé vide hérite de ce propriétaire au premier montage).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as non-root user (node user uid 1000 ships with the official image)
USER node

# Default port — can be overridden via PORT env var at docker run time
ENV PORT=3000
ENV TRANSPORT=http
EXPOSE 3000

# Healthcheck — Docker engine calls /health every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-3000}/health" || exit 1

# Required env vars at runtime (set via docker run -e or compose):
#   - SUPABASE_URL
#   - SUPABASE_ANON_KEY
#   - SUPABASE_JWT_SECRET
# Optional:
#   - AGENT_TOKEN_KEY (32 octets base64) : active les jetons d'agent ; AGENT_TOKEN_FILE (défaut /data/agent-tokens.json)
#   - USER_TIMEZONE (défaut Europe/Paris)
#   - PORT (default 3000)
#   - TRANSPORT (default http ; only http makes sense in a container)

CMD ["node", "dist/index.js"]

# ─── Image metadata (OCI labels) ────────────────────────────────────────────
LABEL org.opencontainers.image.title="agenticfocus-mcp-server"
LABEL org.opencontainers.image.description="MCP server for AgenticFocus — multi-user, JWT-authenticated, StreamableHTTP transport"
LABEL org.opencontainers.image.version="0.6.0"
LABEL org.opencontainers.image.source="https://github.com/AvaPuschmann/agenticfocus-mcp-server"
LABEL org.opencontainers.image.licenses="ISC"
