FROM docker.io/eceasy/cli-proxy-api:v7.3.4@sha256:97825da3009f98acf78b5c172fde650a5fbe7a690950a69ce6d7b535d77d4266 AS cliproxy-binary

FROM oven/bun:1.4.2-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS builder
COPY . .
RUN bun run typecheck && bun run build

FROM oven/bun:1.4.2-slim AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

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
    CLIPROXY_BUNDLED_VERSION=7.3.4
COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/dist ./dist
COPY --from=cliproxy-binary /CLIProxyAPI/CLIProxyAPI /opt/cliproxy/cli-proxy-api
RUN mkdir -p /data && chown bun:bun /data
WORKDIR /app/dist
USER bun
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/api/live').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "--smol", "index.js"]
