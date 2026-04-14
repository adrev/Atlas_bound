# ── Build stage ─────────────────────────────────────────────
FROM node:20-alpine AS builder

# Native deps for bcrypt compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files for all workspaces
COPY package*.json ./
COPY shared/package*.json ./shared/
COPY server/package*.json ./server/
COPY client/package*.json ./client/

# Install all dependencies (including devDependencies for build)
RUN npm install

# Copy source code
COPY . .

# Build in dependency order
RUN npm run build --workspace=shared
RUN npm run build --workspace=client
RUN npm run build --workspace=server

# ── Production deps stage (clean install, no build tools) ──
FROM node:20-alpine AS deps

WORKDIR /app
COPY package*.json ./
COPY shared/package*.json ./shared/
COPY server/package*.json ./server/
COPY client/package*.json ./client/
RUN npm install --omit=dev --workspace=server --workspace=shared

# ── Production stage ───────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy production-only node_modules (no build tools, no dev deps)
COPY --from=deps /app/node_modules ./node_modules

# Copy built artifacts from builder
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/client/dist ./client/dist

# Copy static assets needed at runtime
COPY client/public ./client/public

# Production environment
ENV NODE_ENV=production
ENV PORT=8080

# Cloud Run uses port 8080 by default
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/api/health || exit 1

# Start the server
CMD ["node", "server/dist/index.js"]
