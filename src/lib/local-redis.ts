import Redis from "ioredis"

let client: Redis | undefined

function redisUrl() {
  return process.env.REDIS_URL || "redis://rawroute-redis:6379"
}

export function getLocalRedis() {
  if (client) return client
  client = new Redis(redisUrl(), {
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
  try {
    return (await getLocalRedis().ping()) === "PONG"
  } catch {
    return false
  }
}

export async function closeLocalRedis() {
  if (!client) return
  await client.quit().catch(() => client?.disconnect())
  client = undefined
}
