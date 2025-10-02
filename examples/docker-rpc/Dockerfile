# syntax=docker/dockerfile:1.6

FROM node:24-bullseye AS builder

WORKDIR /workspace

# Copy repositories required for local file dependencies
COPY naylence-core-ts ./naylence-core-ts
COPY naylence-factory-ts ./naylence-factory-ts
COPY naylence-runtime-ts ./naylence-runtime-ts

# Install and build shared packages first to warm dependency cache
WORKDIR /workspace/naylence-core-ts
RUN npm install --legacy-peer-deps \
  && npm run build

WORKDIR /workspace/naylence-factory-ts
RUN npm install --legacy-peer-deps \
  && npm run build

WORKDIR /workspace/naylence-runtime-ts
RUN npm install --legacy-peer-deps \
  && npm run build

FROM node:24-bullseye-slim AS runtime

WORKDIR /app

# Copy built artifacts and node_modules from builder stage
COPY --from=builder /workspace/naylence-core-ts /opt/naylence-core-ts
COPY --from=builder /workspace/naylence-factory-ts /opt/naylence-factory-ts
COPY --from=builder /workspace/naylence-runtime-ts /opt/naylence-runtime-ts

ENV NODE_ENV=production \
  PATH="/opt/naylence-runtime-ts/node_modules/.bin:${PATH}" \
  SENTINEL_HTTP_PORT=8000 \
  SENTINEL_WS_PORT=8000 \
  SENTINEL_PUBLIC_URL=http://localhost:28000

WORKDIR /opt/naylence-runtime-ts

RUN mkdir -p /opt/naylence-runtime-ts/local-sentinel

EXPOSE 8000

CMD ["node", "--enable-source-maps", "local-sentinel/docker-sentinel-calculator.mjs"]
