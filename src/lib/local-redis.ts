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
  return (await boundedCommand(redis => redis.ping())) === "PONG"
}

function boundedCommand<T>(command: (redis: Redis) => Promise<T>): Promise<T | undefined> {
  const redis = getLocalRedis()
  return new Promise(resolve => {
    const finish = (value: T | undefined) => {
      clearTimeout(timer)
      redis.off("ready", run)
      redis.off("end", unavailable)
      resolve(value)
    }
    const unavailable = () => finish(undefined)
    const run = async () => {
      redis.off("ready", run)
      try { finish(await command(redis)) }
      catch { unavailable() }
    }
    // Readiness and execution share one deadline. Keep the offline queue
    // disabled so a timed-out operation cannot be sent after reconnection.
    const timer = setTimeout(unavailable, redisCommandTimeoutMs)
    if (redis.status === "ready") void run()
    else if (redis.status === "end") unavailable()
    else {
      redis.once("ready", run)
      redis.once("end", unavailable)
    }
  })
}

/** Best-effort cache operations. Redis must never become a gateway dependency. */
export function localRedisGet(key: string) {
  return boundedCommand(redis => redis.get(key))
}

export async function localRedisSet(key: string, value: string, ttlMs: number) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))
  return (await boundedCommand(redis => redis.setex(key, ttlSeconds, value))) !== undefined
}

/**
 * Best-effort distributed single-flight marker. `undefined` means Redis was
 * unavailable; callers can fall back to their process-local guard.
 */
export async function localRedisSetIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean | undefined> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false
  const result = await boundedCommand(redis => redis.set(key, value, "PX", Math.max(1, Math.ceil(ttlMs)), "NX"))
  return result === undefined ? undefined : result === "OK"
}

export async function localRedisDelete(...keys: string[]) {
  if (!keys.length) return false
  return (await boundedCommand(redis => redis.del(...keys))) !== undefined
}

/** Delete a distributed lock only when it is still owned by the caller. */
export async function localRedisCompareAndDelete(key: string, expectedValue: string) {
  const result = await boundedCommand(redis => redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    key,
    expectedValue,
  ))
  return typeof result === "number" ? result > 0 : false
}

export async function closeLocalRedis() {
  if (!client) return
  await client.quit().catch(() => client?.disconnect())
  client = undefined
}
