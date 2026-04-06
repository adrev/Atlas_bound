FROM node:20-alpine

WORKDIR /app

# Copy package files for all workspaces
COPY package*.json ./
COPY shared/package*.json ./shared/
COPY server/package*.json ./server/
COPY client/package*.json ./client/

# Install all dependencies
RUN npm install

# Copy source code
COPY . .

# Build in dependency order
RUN npm run build --workspace=shared
RUN npm run build --workspace=client
RUN npm run build --workspace=server

# Expose the server port
EXPOSE 3001

# Production environment
ENV NODE_ENV=production

# Start the server (which serves the client build in production)
CMD ["node", "server/dist/index.js"]
