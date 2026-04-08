# Escrow Service ACP Template — Docker image
# Wraps the escrow-service in the ACP tenant framework so it can be
# spawned via hm.spawn like any other tenant.
#
# Build context: parent directory (needs agentic_hosting/, sphere-sdk/, escrow-service/)
# Build: cd .. && docker build -f escrow-service/Dockerfile -t ghcr.io/unicitynetwork/agentic-hosting/escrow:0.1 .
# Run:   Spawned by the Host Manager via hm.spawn (not run directly)

# Stage 1: Build
FROM node:22-alpine AS build

WORKDIR /build

# Copy package files and dependencies from the parent build context
COPY agentic_hosting/package.json agentic_hosting/package-lock.json ./
COPY sphere-sdk/ ./sphere-sdk/
COPY escrow-service/ ./escrow-service/

# Rewrite file: references to point to local copies inside the build context
RUN sed -i 's|"file:../sphere-sdk"|"file:./sphere-sdk"|' package.json \
 && sed -i 's|"file:../escrow-service"|"file:./escrow-service"|' package.json \
 && npm install

# Build escrow-service first (produces dist/ with .d.ts for type resolution)
RUN cd escrow-service && npx tsc

# Copy source code and build configuration
COPY agentic_hosting/src/ ./src/
COPY agentic_hosting/tsconfig.json agentic_hosting/tsup.config.ts ./

# Build TypeScript (tsup bundles escrow entry point with escrow-service deps)
RUN npx tsup

# Stage 2: Runtime
FROM node:22-alpine

# Install tini for proper PID 1 signal handling
RUN apk add --no-cache tini

WORKDIR /app

# Copy compiled output from build stage
COPY --from=build /build/dist ./dist/

# Copy package files for production dependencies
COPY agentic_hosting/package.json agentic_hosting/package-lock.json ./

# Copy sphere-sdk and escrow-service for production dependency resolution
COPY sphere-sdk/ ./sphere-sdk/
COPY escrow-service/ ./escrow-service/

# Rewrite file: references and install production dependencies only
RUN sed -i 's|"file:../sphere-sdk"|"file:./sphere-sdk"|' package.json \
 && sed -i 's|"file:../escrow-service"|"file:./escrow-service"|' package.json \
 && npm install --omit=dev

# Create required directories for wallet, tokens, and escrow state
RUN mkdir -p /data/wallet /data/tokens /data/escrow && chown -R node:node /data

# Set environment variables
ENV NODE_ENV=production
ENV ESCROW_DATA_DIR=/data/escrow

# Run as non-root user
USER node

# Use tini as entrypoint for proper signal handling
ENTRYPOINT ["tini", "--"]

# Run the ACP-wrapped escrow service
CMD ["node", "/app/dist/escrow.js"]
