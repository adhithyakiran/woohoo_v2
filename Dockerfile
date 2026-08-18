# Single image, multiple entrypoints — compose selects the service via `command`.
#
# Note on dependencies: `tsx` is a RUNTIME dependency here, not a dev one, because the
# services are executed directly from TypeScript (`npm run gateway` → `tsx …/main.ts`).
# Installing with --omit=dev while tsx sat in devDependencies produced an image that
# built cleanly and then crashed on start with "tsx: not found".

FROM node:22-alpine AS deps
WORKDIR /app

# Copy only manifests first so this layer caches until dependencies actually change.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json          packages/contracts/
COPY packages/otel/package.json               packages/otel/
COPY services/policy-service/package.json     services/policy-service/
COPY services/woohoo-core/package.json        services/woohoo-core/
COPY services/adapter-simulator/package.json  services/adapter-simulator/
COPY services/adapter-honeywell/package.json  services/adapter-honeywell/
COPY services/device-gateway/package.json     services/device-gateway/
COPY services/edge-gateway/package.json       services/edge-gateway/
COPY tools/device-simulator/package.json      tools/device-simulator/
COPY eval/package.json                        eval/

# `npm ci` is reproducible and fails loudly on a lockfile mismatch — which is what you
# want in a build. Do not add a `|| npm install` fallback: it converts a real problem
# into a silently different dependency tree.
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# tini gives us correct signal handling so `docker compose down` stops cleanly
# instead of waiting out the 10s kill timeout.
RUN apk add --no-cache tini curl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

USER node
EXPOSE 8443

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8443/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "gateway"]
