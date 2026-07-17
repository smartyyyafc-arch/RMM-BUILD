# ---- Build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install dependencies with the lockfile for reproducible builds.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/agent/package.json packages/agent/
RUN npm ci

# Copy sources and compile.
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm run build

# Drop dev dependencies for a lean runtime image.
RUN npm prune --omit=dev

# ---- Runtime stage ---------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Copy the built app and production dependencies.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages

# The server persists its SQLite database here; mount a volume to keep it.
VOLUME ["/app/data"]
ENV RMM_DB_PATH=/app/data/rmm.db
ENV PORT=8080
EXPOSE 8080

# node:sqlite is behind an experimental flag on Node 22.
CMD ["node", "--experimental-sqlite", "packages/server/dist/index.js"]
