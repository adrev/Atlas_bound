# ── Build stage ─────────────────────────────────────────────
FROM node:20-alpine AS builder

# Native deps for libsql + bcrypt compilation
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

# ── Production stage ───────────────────────────────────────
FROM node:20-alpine

# Native deps needed at runtime for libsql + bcrypt
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY shared/package*.json ./shared/
COPY server/package*.json ./server/

# Install production dependencies only
RUN npm install --omit=dev --workspace=server --workspace=shared

# Copy built artifacts from builder
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/client/dist ./client/dist

# Copy static assets needed at runtime
COPY server/uploads ./server/uploads
COPY client/public ./client/public

# Create data directory for SQLite (local file, synced to Turso)
RUN mkdir -p /app/server/data

# Production environment
ENV NODE_ENV=production
ENV PORT=8080

# Cloud Run uses port 8080 by default
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/api/compendium/monsters?limit=1 || exit 1

# Start the server
CMD ["node", "server/dist/index.js"]
