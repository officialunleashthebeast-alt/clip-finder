# ---------- Reddit Scraper — Render deployment image ----------
# Base: official Node 22 image (slim variant = small + fast).
FROM node:22-slim

# Install ffmpeg (required by /api/download for muxing video+audio).
# --no-install-recommends keeps the image small.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# All app files live in /app inside the container.
WORKDIR /app

# Step 1: copy only package.json + lockfile first so Docker can cache
# the "npm ci" layer when only source code changes.
COPY package*.json ./

# Install ALL deps (we need dev deps to run the build step).
RUN npm ci

# Step 2: copy the rest of the source.
COPY . .

# Step 3: build the frontend (vite) + bundle the server (esbuild).
RUN npm run build

# Production mode: server.ts:280 checks this to serve dist/ instead of vite dev.
ENV NODE_ENV=production
# Render injects PORT itself, but we expose 3000 as a default for local docker runs.
EXPOSE 3000

# Start the bundled server.
CMD ["node", "dist/server.cjs"]
