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
    DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION
COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/dist ./dist
WORKDIR /app/dist
USER bun
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "--smol", "index.js"]
