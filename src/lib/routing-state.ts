import { Redis } from "@upstash/redis"

import type { ProviderApiKey } from "@/lib/types"
import { currentWorkspaceId } from "@/lib/workspace-context"

export interface RoutingRedis {
  eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown>
  get<T = string>(key: string): Promise<T | null>
  set(key: string, value: string, options?: { ex?: number }): Promise<unknown>
  createScript?: (script: string) => RoutingRedisScript
}

interface RoutingRedisScript {
  exec(keys: string[], args: string[]): Promise<unknown>
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
  /** Codex OAuth providers do not expose reliable RPM/concurrency limits. */
  bypassCapacityLimits?: boolean
  sessionKey?: string
  hardAffinity: boolean
  requiredCredentialId?: string
  responseId?: string
  budget?: {
    key: string
    limitMicros: number
    spentMicros: number
    reservationMicros: number
    ttlSeconds: number
  }
}

interface ReleaseInput {
  providerId: string
  modelId: string
  credentialId: string
  leaseId: string
  status: number
  retryAfterSeconds?: number
  budget?: {
    key: string
    reservationMicros: number
    actualMicros: number
    ttlSeconds: number
  }
}

interface BudgetReservationInput {
  key: string
  limitMicros: number
  spentMicros: number
  reservationMicros: number
  ttlSeconds: number
}

const reserveScript = `
local affinity = KEYS[1]
local responseAffinity = KEYS[2]
local ttl = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local hard = ARGV[3] == "1"
local required = ARGV[4]
local leaseId = ARGV[5]
local leaseTtlMs = tonumber(ARGV[6])
local bypassCapacityLimits = ARGV[7] == "1"
local responseCredential = responseAffinity ~= "" and redis.call("GET", responseAffinity) or false
if hard and responseAffinity ~= "" and required == "" and not responseCredential then
  return {"hard-missing"}
end
local sessionCredential = affinity ~= "" and redis.call("GET", affinity) or false
local pinned = required ~= "" and required or (responseCredential or sessionCredential)
local bestIndex = nil
local bestScore = nil
local bestPriority = nil
local pinnedIndex = nil
local retryAfter = nil
local pinnedRetryAfter = nil
local capacityBlocked = false
local upstreamRateLimited = false
local upstreamUnavailable = false
local pinnedCooldownStatus = nil

local redisTime = redis.call("TIME")
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)

for index = 1, count do
  local offset = 7 + ((index - 1) * 4)
  local id = ARGV[offset + 1]
  local rpmLimit = tonumber(ARGV[offset + 2])
  local concurrencyLimit = tonumber(ARGV[offset + 3])
  local priority = tonumber(ARGV[offset + 4])
  local keyOffset = 3 + ((index - 1) * 3)
  redis.call("ZREMRANGEBYSCORE", KEYS[keyOffset], 0, now - 60000)
  redis.call("ZREMRANGEBYSCORE", KEYS[keyOffset + 1], 0, now)
  local rpm = tonumber(redis.call("ZCARD", KEYS[keyOffset]) or "0")
  local inflight = tonumber(redis.call("ZCARD", KEYS[keyOffset + 1]) or "0")
  local cooldown = tonumber(redis.call("TTL", KEYS[keyOffset + 2]))
  local cooldownStatus = cooldown > 0 and redis.call("GET", KEYS[keyOffset + 2]) or false
  local blocked = false
  local candidateRetry = 1
  if cooldown > 0 then
    blocked = true
    if cooldownStatus == "429" then upstreamRateLimited = true else upstreamUnavailable = true end
    if cooldown > candidateRetry then candidateRetry = cooldown end
  end
  if not bypassCapacityLimits and rpm >= rpmLimit then
    blocked = true
    capacityBlocked = true
    local oldest = redis.call("ZRANGE", KEYS[keyOffset], 0, 0, "WITHSCORES")
    if oldest[2] ~= nil then
      local rpmRetry = math.ceil((tonumber(oldest[2]) + 60000 - now) / 1000)
      if rpmRetry > candidateRetry then candidateRetry = rpmRetry end
    end
  end
  if not bypassCapacityLimits and inflight >= concurrencyLimit then
    blocked = true
    capacityBlocked = true
    local oldestLease = redis.call("ZRANGE", KEYS[keyOffset + 1], 0, 0, "WITHSCORES")
    if oldestLease[2] ~= nil then
      local leaseRetry = math.ceil((tonumber(oldestLease[2]) - now) / 1000)
      if leaseRetry > candidateRetry then candidateRetry = leaseRetry end
    end
  end
  local usable = cooldown <= 0 and (bypassCapacityLimits or (rpm < rpmLimit and inflight < concurrencyLimit))
  if blocked and (retryAfter == nil or candidateRetry < retryAfter) then retryAfter = candidateRetry end
  if blocked and id == pinned then
    pinnedRetryAfter = candidateRetry
    if cooldown > 0 then pinnedCooldownStatus = cooldownStatus end
  end
  if id == pinned and usable then pinnedIndex = index end
  if usable then
    local load = bypassCapacityLimits and inflight or math.max(rpm / rpmLimit, inflight / concurrencyLimit)
    if bestScore == nil or load < bestScore or (load == bestScore and (bestPriority == nil or priority > bestPriority)) then
      bestScore = load; bestPriority = priority; bestIndex = index
    end
  end
end

local selected = pinnedIndex or bestIndex
if pinned ~= false and pinned ~= nil and pinned ~= "" and pinnedIndex == nil and hard then
  if pinnedCooldownStatus == "429" then return {"upstream-rate-limited", tostring(pinnedRetryAfter or 1)} end
  if pinnedCooldownStatus ~= nil then return {"upstream-unavailable", tostring(pinnedRetryAfter or 1)} end
  return {"hard-unavailable", pinned, tostring(pinnedRetryAfter or 1)}
end
if selected == nil then
  if upstreamUnavailable then return {"upstream-unavailable", tostring(retryAfter or 1)} end
  if upstreamRateLimited and not capacityBlocked then return {"upstream-rate-limited", tostring(retryAfter or 1)} end
  if capacityBlocked then return {"capacity", tostring(retryAfter or 1)} end
  return {"upstream-unavailable", tostring(retryAfter or 1)}
end

local budgetOffset = 7 + (count * 4)
local budgetKey = KEYS[3 + (count * 3)]
if ARGV[budgetOffset + 1] == "1" then
  local limit = tonumber(ARGV[budgetOffset + 2])
  local reservation = tonumber(ARGV[budgetOffset + 3])
  local initialSpent = tonumber(ARGV[budgetOffset + 4]) or 0
  local budgetTtl = tonumber(ARGV[budgetOffset + 5])
  local current = tonumber(redis.call("GET", budgetKey)) or initialSpent
  if current + reservation > limit then return {"budget", tostring(budgetTtl)} end
  redis.call("SET", budgetKey, tostring(current + reservation), "EX", budgetTtl)
  redis.call("SET", budgetKey .. ":lease:" .. leaseId, tostring(reservation), "EX", budgetTtl)
end

local offset = 7 + ((selected - 1) * 4)
local id = ARGV[offset + 1]
local keyOffset = 3 + ((selected - 1) * 3)
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
  redis.call("SET", KEYS[3], tostring(status), "EX", tonumber(ARGV[2]))
end
if #KEYS >= 5 then
  local reserved = tonumber(redis.call("GET", KEYS[5])) or 0
  local current = tonumber(redis.call("GET", KEYS[4])) or 0
  local actual = tonumber(ARGV[5]) or 0
  redis.call("SET", KEYS[4], tostring(math.max(0, current - reserved + actual)), "EX", tonumber(ARGV[6]) or 60)
  redis.call("DEL", KEYS[5])
end
return {"ok"}
`

const budgetReserveScript = `
local current = tonumber(redis.call("GET", KEYS[1])) or tonumber(ARGV[2]) or 0
local limit = tonumber(ARGV[1])
local reservation = tonumber(ARGV[3])
if current + reservation > limit then return {"budget", tostring(ARGV[4])} end
local lease = ARGV[5]
local ttl = tonumber(ARGV[4])
redis.call("SET", KEYS[1], tostring(current + reservation), "EX", ttl)
redis.call("SET", KEYS[2] .. lease, tostring(reservation), "EX", ttl)
return {"ok", lease}
`

const budgetSettleScript = `
local reserved = tonumber(redis.call("GET", KEYS[2])) or 0
local current = tonumber(redis.call("GET", KEYS[1])) or 0
local actual = tonumber(ARGV[1]) or 0
redis.call("SET", KEYS[1], tostring(math.max(0, current - reserved + actual)), "EX", tonumber(ARGV[2]) or 60)
redis.call("DEL", KEYS[2])
return {"ok"}
`

const renewScript = `
local leaseId = ARGV[1]
local leaseTtlMs = tonumber(ARGV[2])
local existing = redis.call("ZSCORE", KEYS[1], leaseId)
if not existing then return 0 end
local redisTime = redis.call("TIME")
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
redis.call("ZADD", KEYS[1], now + leaseTtlMs, leaseId)
redis.call("EXPIRE", KEYS[1], math.ceil(leaseTtlMs / 1000) + 1)
return 1
`

const mapResponsesScript = `
local ttl = tonumber(ARGV[1])
local credentialId = ARGV[2]
for index = 1, #KEYS do
  redis.call("SET", KEYS[index], credentialId, "EX", ttl)
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
  private readonly defaultRpmLimit: number
  private readonly defaultMaxConcurrency: number
  private readonly reserveRunner: (keys: string[], args: Array<string | number>) => Promise<unknown>
  private readonly releaseRunner: (keys: string[], args: Array<string | number>) => Promise<unknown>
  private readonly renewRunner: (keys: string[], args: Array<string | number>) => Promise<unknown>
  private readonly mapResponsesRunner: (keys: string[], args: Array<string | number>) => Promise<unknown>
  private readonly budgetReserveRunner: (keys: string[], args: Array<string | number>) => Promise<unknown>
  private readonly budgetSettleRunner: (keys: string[], args: Array<string | number>) => Promise<unknown>

  constructor(private readonly redis: RoutingRedis, options: StoreOptions = {}) {
    this.prefix = options.prefix || "rawroute:routing:v1"
    this.affinityTtlSeconds = options.affinityTtlSeconds || positiveInteger(Number(process.env.ROUTING_AFFINITY_TTL_SECONDS), 3600)
    this.responseTtlSeconds = options.responseTtlSeconds || positiveInteger(Number(process.env.ROUTING_RESPONSE_TTL_SECONDS), 86400)
    this.inflightLeaseTtlSeconds = options.inflightLeaseTtlSeconds || positiveInteger(Number(process.env.ROUTING_INFLIGHT_LEASE_TTL_SECONDS), 900)
    this.defaultRpmLimit = positiveInteger(Number(process.env.ROUTING_DEFAULT_RPM_LIMIT), 60)
    this.defaultMaxConcurrency = positiveInteger(Number(process.env.ROUTING_DEFAULT_MAX_CONCURRENCY), 4)
    const reserveScriptRunner = redis.createScript?.(reserveScript)
    const releaseScriptRunner = redis.createScript?.(releaseScript)
    const renewScriptRunner = redis.createScript?.(renewScript)
    const mapResponsesScriptRunner = redis.createScript?.(mapResponsesScript)
    const budgetReserveScriptRunner = redis.createScript?.(budgetReserveScript)
    const budgetSettleScriptRunner = redis.createScript?.(budgetSettleScript)
    this.reserveRunner = reserveScriptRunner
      ? (keys, args) => reserveScriptRunner.exec(keys, args.map(String))
      : (keys, args) => redis.eval(reserveScript, keys, args)
    this.releaseRunner = releaseScriptRunner
      ? (keys, args) => releaseScriptRunner.exec(keys, args.map(String))
      : (keys, args) => redis.eval(releaseScript, keys, args)
    this.renewRunner = renewScriptRunner
      ? (keys, args) => renewScriptRunner.exec(keys, args.map(String))
      : (keys, args) => redis.eval(renewScript, keys, args)
    this.mapResponsesRunner = mapResponsesScriptRunner
      ? (keys, args) => mapResponsesScriptRunner.exec(keys, args.map(String))
      : (keys, args) => redis.eval(mapResponsesScript, keys, args)
    this.budgetReserveRunner = budgetReserveScriptRunner
      ? (keys, args) => budgetReserveScriptRunner.exec(keys, args.map(String))
      : (keys, args) => redis.eval(budgetReserveScript, keys, args)
    this.budgetSettleRunner = budgetSettleScriptRunner
      ? (keys, args) => budgetSettleScriptRunner.exec(keys, args.map(String))
      : (keys, args) => redis.eval(budgetSettleScript, keys, args)
  }

  private scope(providerId: string, modelId: string) {
    return `${currentWorkspaceId()}:${providerId}:${modelId}`
  }

  private responseKey(providerId: string, responseId: string) {
    return `${this.prefix}:response:${currentWorkspaceId()}:${providerId}:${responseId}`
  }

  leaseRenewalIntervalMs() {
    return Math.max(1000, Math.floor((this.inflightLeaseTtlSeconds * 1000) / 3))
  }

  async reserve(input: ReserveInput) {
    let credentials = input.credentials
    if (credentials.some((credential) => !credential.enabled)) credentials = credentials.filter((credential) => credential.enabled)
    const scope = this.scope(input.providerId, input.modelId)
    const affinityKey = input.sessionKey ? `${this.prefix}:affinity:${scope}:${input.sessionKey}` : ""
    const responseAffinityKey = input.responseId ? this.responseKey(input.providerId, input.responseId) : ""
    const keys = [affinityKey, responseAffinityKey]
    const leaseId = crypto.randomUUID()
    const args: Array<string | number> = [this.affinityTtlSeconds, credentials.length, input.hardAffinity ? 1 : 0, input.requiredCredentialId || "", leaseId, this.inflightLeaseTtlSeconds * 1000, input.bypassCapacityLimits ? 1 : 0]
    for (const credential of credentials) {
      const credentialScope = `${scope}:${credential.id}`
      keys.push(`${this.prefix}:rpm:${credentialScope}`, `${this.prefix}:inflight:${credentialScope}`, `${this.prefix}:cooldown:${credentialScope}`)
      args.push(
        credential.id,
        input.bypassCapacityLimits ? 0 : positiveInteger(credential.rpmLimit, this.defaultRpmLimit),
        input.bypassCapacityLimits ? 0 : positiveInteger(credential.maxConcurrency, this.defaultMaxConcurrency),
        Number.isFinite(credential.priority) ? Number(credential.priority) : 0,
      )
    }
    keys.push(input.budget?.key || "")
    if (input.budget) args.push(1, input.budget.limitMicros, input.budget.reservationMicros, input.budget.spentMicros, input.budget.ttlSeconds)
    else args.push(0, 0, 0, 0, 0)
    const response = await this.reserveRunner(keys, args) as Array<string | number>
    if (response?.[0] === "ok") return { ok: true as const, credentialId: String(response[1]), affinity: String(response[2]), leaseId, budget: input.budget }
    if (response?.[0] === "hard-missing") {
      return { ok: false as const, reason: "hard-response-missing" as const, retryAfterSeconds: 1 }
    }
    if (response?.[0] === "hard-unavailable") {
      return { ok: false as const, reason: "hard-affinity-unavailable" as const, credentialId: String(response[1]), retryAfterSeconds: Number(response[2]) || 1 }
    }
    if (response?.[0] === "budget") return { ok: false as const, reason: "budget" as const, retryAfterSeconds: Number(response[1]) || 1 }
    if (response?.[0] === "upstream-rate-limited") return { ok: false as const, reason: "upstream-rate-limited" as const, retryAfterSeconds: Number(response[1]) || 1 }
    if (response?.[0] === "upstream-unavailable") return { ok: false as const, reason: "upstream-unavailable" as const, retryAfterSeconds: Number(response[1]) || 1 }
    return { ok: false as const, reason: "capacity" as const, retryAfterSeconds: Number(response?.[1]) || 1 }
  }

  async release(input: ReleaseInput) {
    const scope = `${this.scope(input.providerId, input.modelId)}:${input.credentialId}`
    const keys = [
      `${this.prefix}:inflight:${scope}`,
      `${this.prefix}:rpm:${scope}`,
      `${this.prefix}:cooldown:${scope}`,
    ]
    const args: Array<string | number> = [input.status, positiveInteger(input.retryAfterSeconds, 5), 0, input.leaseId]
    if (input.budget) {
      keys.push(input.budget.key, `${input.budget.key}:lease:${input.leaseId}`)
      args.push(input.budget.actualMicros, positiveInteger(input.budget.ttlSeconds, 60))
    }
    await this.releaseRunner(keys, args)
  }

  async reserveBudget(input: BudgetReservationInput) {
    const leaseId = crypto.randomUUID()
    const response = await this.budgetReserveRunner([input.key, `${input.key}:lease:`], [input.limitMicros, input.spentMicros, input.reservationMicros, input.ttlSeconds, leaseId]) as Array<string | number>
    if (response?.[0] === "ok") return { ok: true as const, leaseId, reservationMicros: input.reservationMicros }
    return { ok: false as const, reason: "budget" as const, retryAfterSeconds: Number(response?.[1]) || input.ttlSeconds }
  }

  async settleBudget(input: { key: string; leaseId: string; actualMicros: number; ttlSeconds: number }) {
    await this.budgetSettleRunner([input.key, `${input.key}:lease:${input.leaseId}`], [input.actualMicros, input.ttlSeconds])
  }

  async renew(input: { providerId: string; modelId: string; credentialId: string; leaseId: string }) {
    const scope = `${this.scope(input.providerId, input.modelId)}:${input.credentialId}`
    const response = await this.renewRunner([
      `${this.prefix}:inflight:${scope}`,
    ], [input.leaseId, this.inflightLeaseTtlSeconds * 1000])
    return Number(response) === 1
  }

  async credentialForResponse(providerId: string, responseId: string) {
    return this.redis.get<string>(this.responseKey(providerId, responseId))
  }

  async mapResponse(providerId: string, responseId: string, credentialId: string) {
    await this.mapResponses([responseId], providerId, credentialId)
  }

  async mapResponses(responseIds: string[], providerId: string, credentialId: string) {
    const uniqueResponseIds: string[] = []
    const seen = new Set<string>()
    for (const responseId of responseIds) {
      if (uniqueResponseIds.length >= 64) break
      if (!responseId || responseId.length > 512 || seen.has(responseId)) continue
      seen.add(responseId)
      uniqueResponseIds.push(responseId)
    }
    if (!uniqueResponseIds.length) return
    if (uniqueResponseIds.length === 1) {
      await this.redis.set(this.responseKey(providerId, uniqueResponseIds[0]), credentialId, { ex: this.responseTtlSeconds })
      return
    }
    await this.mapResponsesRunner(
      uniqueResponseIds.map((responseId) => this.responseKey(providerId, responseId)),
      [this.responseTtlSeconds, credentialId],
    )
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
