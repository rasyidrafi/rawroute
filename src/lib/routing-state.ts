import { Redis } from "@upstash/redis"

import type { ProviderApiKey } from "@/lib/types"

export interface RoutingRedis {
  eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown>
  get<T = string>(key: string): Promise<T | null>
  set(key: string, value: string, options?: { ex?: number }): Promise<unknown>
}

interface StoreOptions {
  prefix?: string
  affinityTtlSeconds?: number
  responseTtlSeconds?: number
  inflightLeaseTtlSeconds?: number
}

interface ReserveInput {
  providerId: string
  modelId: string
  credentials: ProviderApiKey[]
  sessionKey?: string
  hardAffinity: boolean
  requiredCredentialId?: string
}

interface ReleaseInput {
  providerId: string
  modelId: string
  credentialId: string
  leaseId: string
  status: number
  retryAfterSeconds?: number
  latencyMs: number
}

const reserveScript = `
local affinity = KEYS[1]
local ttl = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local hard = ARGV[3] == "1"
local required = ARGV[4]
local now = tonumber(ARGV[5])
local leaseId = ARGV[6]
local leaseTtlMs = tonumber(ARGV[7])
local pinned = required ~= "" and required or redis.call("GET", affinity)
local bestIndex = nil
local bestScore = nil
local pinnedIndex = nil
local retryAfter = 1

for index = 1, count do
  local offset = 7 + ((index - 1) * 4)
  local id = ARGV[offset + 1]
  local rpmLimit = tonumber(ARGV[offset + 2])
  local concurrencyLimit = tonumber(ARGV[offset + 3])
  local priority = tonumber(ARGV[offset + 4])
  local keyOffset = 2 + ((index - 1) * 3)
  redis.call("ZREMRANGEBYSCORE", KEYS[keyOffset], 0, now - 60000)
  redis.call("ZREMRANGEBYSCORE", KEYS[keyOffset + 1], 0, now)
  local rpm = tonumber(redis.call("ZCARD", KEYS[keyOffset]) or "0")
  local inflight = tonumber(redis.call("ZCARD", KEYS[keyOffset + 1]) or "0")
  local cooldown = tonumber(redis.call("TTL", KEYS[keyOffset + 2]))
  if cooldown > retryAfter then retryAfter = cooldown end
  if rpm >= rpmLimit then
    local oldest = redis.call("ZRANGE", KEYS[keyOffset], 0, 0, "WITHSCORES")
    if oldest[2] ~= nil then
      local rpmRetry = math.ceil((tonumber(oldest[2]) + 60000 - now) / 1000)
      if rpmRetry > retryAfter then retryAfter = rpmRetry end
    end
  end
  if inflight >= concurrencyLimit then
    local oldestLease = redis.call("ZRANGE", KEYS[keyOffset + 1], 0, 0, "WITHSCORES")
    if oldestLease[2] ~= nil then
      local leaseRetry = math.ceil((tonumber(oldestLease[2]) - now) / 1000)
      if leaseRetry > retryAfter then retryAfter = leaseRetry end
    end
  end
  local usable = cooldown <= 0 and rpm < rpmLimit and inflight < concurrencyLimit
  if id == pinned and usable then pinnedIndex = index end
  if usable then
    local score = math.max(rpm / rpmLimit, inflight / concurrencyLimit) - (priority * 0.01)
    if bestScore == nil or score < bestScore then bestScore = score; bestIndex = index end
  end
end

local selected = pinnedIndex or bestIndex
if pinned ~= false and pinned ~= nil and pinned ~= "" and pinnedIndex == nil and hard then
  return {"hard-unavailable", pinned, tostring(retryAfter)}
end
if selected == nil then return {"capacity", tostring(retryAfter)} end

local offset = 7 + ((selected - 1) * 4)
local id = ARGV[offset + 1]
local keyOffset = 2 + ((selected - 1) * 3)
redis.call("ZADD", KEYS[keyOffset], now, leaseId)
redis.call("EXPIRE", KEYS[keyOffset], 60)
redis.call("ZADD", KEYS[keyOffset + 1], now + leaseTtlMs, leaseId)
redis.call("EXPIRE", KEYS[keyOffset + 1], math.ceil(leaseTtlMs / 1000) + 1)
if affinity ~= "" then redis.call("SET", affinity, id, "EX", ttl) end
return {"ok", id, pinnedIndex and "sticky" or "new"}
`

const releaseScript = `
redis.call("ZREM", KEYS[1], ARGV[4])
local status = tonumber(ARGV[1])
if status == 429 then
  redis.call("ZREM", KEYS[2], ARGV[4])
  redis.call("SET", KEYS[3], "429", "EX", tonumber(ARGV[2]))
elseif status >= 500 then
  redis.call("SET", KEYS[3], tostring(status), "EX", tonumber(ARGV[3]))
end
return {"ok"}
`

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback
}

export class RedisRoutingStateStore {
  private readonly prefix: string
  private readonly affinityTtlSeconds: number
  private readonly responseTtlSeconds: number
  private readonly inflightLeaseTtlSeconds: number

  constructor(private readonly redis: RoutingRedis, options: StoreOptions = {}) {
    this.prefix = options.prefix || "rawroute:routing:v1"
    this.affinityTtlSeconds = options.affinityTtlSeconds || positiveInteger(Number(process.env.ROUTING_AFFINITY_TTL_SECONDS), 3600)
    this.responseTtlSeconds = options.responseTtlSeconds || positiveInteger(Number(process.env.ROUTING_RESPONSE_TTL_SECONDS), 86400)
    this.inflightLeaseTtlSeconds = options.inflightLeaseTtlSeconds || positiveInteger(Number(process.env.ROUTING_INFLIGHT_LEASE_TTL_SECONDS), 900)
  }

  private scope(providerId: string, modelId: string) {
    return `${providerId}:${modelId}`
  }

  async reserve(input: ReserveInput) {
    const credentials = input.credentials.filter((credential) => credential.enabled)
    const scope = this.scope(input.providerId, input.modelId)
    const affinityKey = input.sessionKey ? `${this.prefix}:affinity:${scope}:${input.sessionKey}` : ""
    const keys = [affinityKey]
    const leaseId = crypto.randomUUID()
    const args: Array<string | number> = [this.affinityTtlSeconds, credentials.length, input.hardAffinity ? 1 : 0, input.requiredCredentialId || "", Date.now(), leaseId, this.inflightLeaseTtlSeconds * 1000]
    for (const credential of credentials) {
      const credentialScope = `${scope}:${credential.id}`
      keys.push(`${this.prefix}:rpm:${credentialScope}`, `${this.prefix}:inflight:${credentialScope}`, `${this.prefix}:cooldown:${credentialScope}`)
      args.push(
        credential.id,
        positiveInteger(credential.rpmLimit, positiveInteger(Number(process.env.ROUTING_DEFAULT_RPM_LIMIT), 60)),
        positiveInteger(credential.maxConcurrency, positiveInteger(Number(process.env.ROUTING_DEFAULT_MAX_CONCURRENCY), 4)),
        Number.isFinite(credential.priority) ? Number(credential.priority) : 0,
      )
    }
    const response = await this.redis.eval(reserveScript, keys, args) as Array<string | number>
    if (response?.[0] === "ok") return { ok: true as const, credentialId: String(response[1]), affinity: String(response[2]), leaseId }
    if (response?.[0] === "hard-unavailable") {
      return { ok: false as const, reason: "hard-affinity-unavailable" as const, credentialId: String(response[1]), retryAfterSeconds: Number(response[2]) || 1 }
    }
    return { ok: false as const, reason: "capacity" as const, retryAfterSeconds: Number(response?.[1]) || 1 }
  }

  async release(input: ReleaseInput) {
    const scope = `${this.scope(input.providerId, input.modelId)}:${input.credentialId}`
    await this.redis.eval(releaseScript, [
      `${this.prefix}:inflight:${scope}`,
      `${this.prefix}:rpm:${scope}`,
      `${this.prefix}:cooldown:${scope}`,
    ], [input.status, positiveInteger(input.retryAfterSeconds, 5), 5, input.leaseId, Math.max(0, Math.round(input.latencyMs))])
  }

  async credentialForResponse(providerId: string, responseId: string) {
    return this.redis.get<string>(`${this.prefix}:response:${providerId}:${responseId}`)
  }

  async mapResponse(providerId: string, responseId: string, credentialId: string) {
    await this.redis.set(`${this.prefix}:response:${providerId}:${responseId}`, credentialId, { ex: this.responseTtlSeconds })
  }
}

let routingStore: RedisRoutingStateStore | undefined

export function getRoutingStateStore() {
  if (routingStore) return routingStore
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error("Upstash Redis is not configured.")
  routingStore = new RedisRoutingStateStore(new Redis({ url, token }))
  return routingStore
}

export function setRoutingStateStoreForTests(store?: RedisRoutingStateStore) {
  routingStore = store
}
