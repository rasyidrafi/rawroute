import Redis from "ioredis"

let client: Redis | undefined

const configuredCommandTimeoutMs = Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 50)
const redisCommandTimeoutMs = Number.isFinite(configuredCommandTimeoutMs) && configuredCommandTimeoutMs > 0
  ? configuredCommandTimeoutMs
  : 50

function redisUrl() {
  return process.env.REDIS_URL || "redis://rawroute-redis:6379"
}

export function getLocalRedis() {
  if (client) return client
  client = new Redis(redisUrl(), {
    commandTimeout: redisCommandTimeoutMs,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: false,
  })
  // Health checks and request paths surface connection failures themselves;
  // keep ioredis from treating a transient outage as an unhandled process
  // error while it reconnects.
  client.on("error", () => undefined)
  return client
}

export async function localRedisHealth() {
  return (await boundedCommand(getLocalRedis().ping())) === "PONG"
}

async function boundedCommand<T>(command: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      command,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), redisCommandTimeoutMs) }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Best-effort cache operations. Redis must never become a gateway dependency. */
export function localRedisGet(key: string) {
  return boundedCommand(getLocalRedis().get(key))
}

export async function localRedisSet(key: string, value: string, ttlMs: number) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))
  return (await boundedCommand(getLocalRedis().setex(key, ttlSeconds, value))) !== undefined
}

export async function localRedisDelete(...keys: string[]) {
  if (!keys.length) return false
  return (await boundedCommand(getLocalRedis().del(...keys))) !== undefined
}

export async function closeLocalRedis() {
  if (!client) return
  await client.quit().catch(() => client?.disconnect())
  client = undefined
}
