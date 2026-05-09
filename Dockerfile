# Escrow Service — Docker image
#
# Two ways to run the resulting image:
#   1. As a standalone service (the original entrypoint, dist/index.js)
#   2. As a tenant under the agentic-hosting Host Manager via the ACP adapter
#      (dist/acp-adapter/main.js — selected by overriding CMD).
#
# The default CMD targets the ACP adapter, since this image is published to
# `ghcr.io/unicitynetwork/agentic-hosting/escrow:0.1` and consumed by the host
# manager. Standalone deployments can override CMD with ["node", "/app/dist/index.js"].
#
# Build context:
#   - escrow-service repo (this directory)
#   - sphere-sdk sibling at ../sphere-sdk (until @unicitylabs/sphere-sdk
#     publishes the swap-module exports to npm)
#
# Build:
#   cd /path/to/parent && \
#   docker build -f escrow-service/Dockerfile \
#                -t ghcr.io/unicitynetwork/agentic-hosting/escrow:0.1 \
#                .

# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:26-alpine@sha256:e71ac5e964b9201072425d59d2e876359efa25dc96bb1768cb73295728d6e4ea AS build

WORKDIR /build

# sphere-sdk is consumed via `file:../sphere-sdk` and must be built (compiled
# to dist/) before npm install can resolve the file: link to its declared
# exports. Both repos must be present in the build context.
COPY sphere-sdk/ ./sphere-sdk/
COPY escrow-service/ ./escrow-service/

# Build sphere-sdk in-place so its dist/ exists when escrow-service does its
# install. (file: dependencies install via symlink — they aren't copied, so we
# need the dist artifacts beside the package.json the link points at.)
RUN cd sphere-sdk && npm ci && npm run build

# Install + build escrow-service (compiles src/ + src/acp-adapter/ to dist/).
RUN cd escrow-service && npm ci && npm run build

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# ---------------------------------------------------------------------------
FROM node:26-alpine@sha256:e71ac5e964b9201072425d59d2e876359efa25dc96bb1768cb73295728d6e4ea

# tini handles PID-1 signal forwarding so SIGTERM from the host manager
# triggers our graceful-shutdown handler instead of being swallowed.
RUN apk add --no-cache tini

WORKDIR /app

# Copy compiled output + package files for production install.
COPY --from=build /build/escrow-service/dist ./dist/
COPY --from=build /build/escrow-service/package.json /build/escrow-service/package-lock.json ./
COPY --from=build /build/sphere-sdk/ ./sphere-sdk/

# Rewrite the file: dependency to the local copy in the image (the original
# `file:../sphere-sdk` would point outside the container). Then install only
# production deps.
RUN sed -i 's|"file:../sphere-sdk"|"file:./sphere-sdk"|' package.json \
 && npm install --omit=dev --ignore-scripts

# Standard host-manager-injected directory layout. Mounted at runtime by the
# manager; created here so the ACP adapter can mkdir under them without
# tripping permission errors on the first boot.
RUN mkdir -p /data/wallet /data/tokens /data/escrow && chown -R node:node /data

ENV NODE_ENV=production
ENV ESCROW_DATA_DIR=/data/escrow

USER node

ENTRYPOINT ["tini", "--"]

# Default to the ACP-wrapped entrypoint (host-manager tenant mode).
# Standalone mode: docker run ... <image> node /app/dist/index.js
CMD ["node", "/app/dist/acp-adapter/main.js"]
