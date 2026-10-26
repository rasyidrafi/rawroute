FROM docker.io/eceasy/cli-proxy-api:v8.0.43@sha256:3f74ca56cba8bea2a2a096a215bb774482d87d257da04c5047e6046493bfd644 AS cliproxy-binary

FROM oven/bun:1.4.2-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/console/package.json apps/console/
COPY packages/platform/package.json packages/platform/
COPY packages/gateway-ai/package.json packages/gateway-ai/
COPY packages/gateway-tools/package.json packages/gateway-tools/
COPY packages/gateway-storage/package.json packages/gateway-storage/
COPY packages/observability/package.json packages/observability/
COPY packages/ui/package.json packages/ui/
RUN bun install --frozen-lockfile

FROM dependencies AS builder
COPY . .
RUN bun run check:architecture && bun run typecheck && bun run build

FROM oven/bun:1.4.2-slim AS runner
ARG DEPLOYMENT_VERSION
LABEL org.opencontainers.image.source="https://github.com/rasyidrafi/rawroute" \
    org.opencontainers.image.revision=$DEPLOYMENT_VERSION
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=8080 \
    DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION \
    RAWROUTE_DATA_DIR=/data \
    CLIPROXY_BUNDLED_BINARY=/opt/cliproxy/cli-proxy-api \
    CLIPROXY_BUNDLED_VERSION=8.0.43
COPY --from=builder --chown=bun:bun /app/dist ./dist
COPY --from=cliproxy-binary /CLIProxyAPI/CLIProxyAPI /opt/cliproxy/cli-proxy-api
RUN mkdir -p /data && chown bun:bun /data
WORKDIR /app/dist
USER bun
EXPOSE 8080 9000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/api/live').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "--smol", "index.js"]
