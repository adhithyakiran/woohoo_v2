# Single image, multiple entrypoints — the compose file selects the service via `command`.
# Non-root, minimal base, no shell tooling beyond what npm needs (§52, runtime hardening).

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/otel/package.json packages/otel/
COPY services/policy-service/package.json services/policy-service/
COPY services/woohoo-core/package.json services/woohoo-core/
COPY services/adapter-simulator/package.json services/adapter-simulator/
COPY services/device-gateway/package.json services/device-gateway/
COPY services/edge-gateway/package.json services/edge-gateway/
COPY tools/device-simulator/package.json tools/device-simulator/
COPY eval/package.json eval/
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund

FROM base AS runtime
ARG SERVICE=device-gateway
ENV SERVICE=${SERVICE}

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Run as the unprivileged node user that the base image already provides.
USER node

# tsx executes TypeScript directly. For production hardening this becomes a compiled
# dist/ build with a read-only root filesystem; kept simple for the Phase 1 pilot.
CMD ["npm", "run", "gateway"]
