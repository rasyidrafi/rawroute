import { Redis } from "@upstash/redis"

import type { ProviderApiKey } from "@/lib/types"
import { currentWorkspaceId } from "@/lib/workspace-context"

interface RoutingRedisPipeline {
  set(key: string, value: string, options?: { ex?: number }): unknown
  exec(): Promise<unknown>
}

export interface RoutingRedis {
  eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown>
  get<T = string>(key: string): Promise<T | null>
  set(key: string, value: string, options?: { ex?: number }): Promise<unknown>
  pipeline?: () => RoutingRedisPipeline
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
  stateTtlSeconds?: number
  stateTouchIntervalSeconds?: number
  refreshAffinityTtl?: boolean
}

interface ReserveInput {
  providerId: string
  modelId: string
  credentials: ProviderApiKey[]
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
  credentialId: string
  leaseId: string
  status: number
  retryAfterSeconds?: number
  budget?: {
    key: string
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

// One provider-scoped hash stores compact state for every credential. Each
// field contains a conservative one-second RPM ring plus active leases and a
// cooldown timestamp. Entries outside the 61-second retention window are
// discarded, preserving rolling-minute behavior without issuing several Redis
// commands per credential.
const reserveScript = `
local affinityTtl = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
local hard = ARGV[3] == "1"
local required = ARGV[4]
local leaseId = ARGV[5]
local leaseTtlMs = tonumber(ARGV[6])
local affinityIndex = tonumber(ARGV[7]) or 0
local responseIndex = tonumber(ARGV[8]) or 0
local budgetKeyIndex = tonumber(ARGV[9]) or 0
local now = tonumber(ARGV[10])
local stateTtl = tonumber(ARGV[11])
local stateTouchIntervalMs = tonumber(ARGV[12])
local refreshAffinity = ARGV[13] == "1"
local credentialOffset = 13
local rpmRetentionMs = 61000
local currentRpmBucket = math.floor(now / 1000) * 1000

if count <= 0 then return {"capacity", "1"} end

local responseAffinity = required == "" and responseIndex > 0 and redis.call("GET", KEYS[responseIndex]) or false
if hard and responseIndex > 0 and required == "" and not responseAffinity then
  return {"hard-missing"}
end
local affinity = affinityIndex > 0 and KEYS[affinityIndex] or ""
-- A required credential or response mapping takes precedence, so the session
-- key is only read when it can affect selection. Sliding TTL still reads the
-- existing value to preserve stickiness before refreshing it below.
local shouldReadSession = affinityIndex > 0 and required == "" and not responseAffinity
local sessionCredential = shouldReadSession and redis.call("GET", affinity) or false
local pinned = required ~= "" and required or (responseAffinity or sessionCredential)

local function parseState(raw)
  local cooldown = 0
  local rpmRaw = ""
  local leasesRaw = ""
  if raw and raw ~= "" then
    local cooldownText, bucketText, leaseText = string.match(raw, "^([^|]*)|([^|]*)|(.*)$")
    if cooldownText ~= nil then
      cooldown = tonumber(cooldownText) or 0
      rpmRaw = bucketText or ""
      leasesRaw = leaseText or ""
    end
  end
  if cooldown <= now then cooldown = 0 end

  local buckets = {}
  local rpm = 0
  local oldestRpmExpiry = nil
  for entry in string.gmatch(rpmRaw, "([^;]+)") do
    local separator = string.find(entry, ":", 1, true)
    if separator then
      local bucketStart = tonumber(string.sub(entry, 1, separator - 1))
      local bucketCount = tonumber(string.sub(entry, separator + 1))
      if bucketStart and bucketCount and bucketCount > 0 and bucketStart + rpmRetentionMs > now then
        buckets[#buckets + 1] = { start = bucketStart, count = bucketCount }
        rpm = rpm + bucketCount
        local expiry = bucketStart + rpmRetentionMs
        if oldestRpmExpiry == nil or expiry < oldestRpmExpiry then oldestRpmExpiry = expiry end
      end
    end
  end

  local leases = {}
  local oldestLeaseExpiry = nil
  for entry in string.gmatch(leasesRaw, "([^;]+)") do
    local first = string.find(entry, ":", 1, true)
    local second = first and string.find(entry, ":", first + 1, true) or nil
    if first and second then
      local id = string.sub(entry, 1, first - 1)
      local expiry = tonumber(string.sub(entry, first + 1, second - 1))
      local rpmBucket = tonumber(string.sub(entry, second + 1))
      if id ~= "" and expiry and rpmBucket and expiry > now then
        leases[#leases + 1] = { id = id, expiry = expiry, rpmBucket = rpmBucket }
        if oldestLeaseExpiry == nil or expiry < oldestLeaseExpiry then oldestLeaseExpiry = expiry end
      end
    end
  end

  return {
    cooldown = cooldown,
    buckets = buckets,
    rpm = rpm,
    oldestRpmExpiry = oldestRpmExpiry,
    leases = leases,
    oldestLeaseExpiry = oldestLeaseExpiry,
  }
end

local function encodeState(state)
  local bucketParts = {}
  for index = 1, #state.buckets do
    local bucket = state.buckets[index]
    bucketParts[index] = tostring(bucket.start) .. ":" .. tostring(bucket.count)
  end
  local leaseParts = {}
  for index = 1, #state.leases do
    local lease = state.leases[index]
    leaseParts[index] = lease.id .. ":" .. tostring(lease.expiry) .. ":" .. tostring(lease.rpmBucket)
  end
  return tostring(state.cooldown or 0) .. "|" .. table.concat(bucketParts, ";") .. "|" .. table.concat(leaseParts, ";")
end

local fields = {"_touch"}
for index = 1, count do
  local offset = credentialOffset + ((index - 1) * 4)
  fields[index + 1] = ARGV[offset + 1]
end
local rawStates = redis.call("HMGET", KEYS[1], unpack(fields))
local nextTouchAt = tonumber(rawStates[1]) or 0
local shouldTouchState = nextTouchAt <= now

-- Removed/disabled credentials would otherwise leave hash fields behind until
-- the whole provider becomes idle. Amortize cleanup with the TTL touch (once a
-- day by default), so the hot path still uses only HMGET + HSET.
if shouldTouchState then
  local activeFields = {}
  for index = 2, #fields do activeFields[fields[index]] = true end
  local staleFields = {}
  for _, field in ipairs(redis.call("HKEYS", KEYS[1])) do
    if field ~= "_touch" and not activeFields[field] then staleFields[#staleFields + 1] = field end
  end
  for startIndex = 1, #staleFields, 128 do
    local chunk = {}
    local endIndex = math.min(startIndex + 127, #staleFields)
    for index = startIndex, endIndex do chunk[#chunk + 1] = staleFields[index] end
    redis.call("HDEL", KEYS[1], unpack(chunk))
  end
end

local states = {}
local bestIndex = nil
local bestScore = nil
local bestPriority = nil
local pinnedIndex = nil
local retryAfter = nil
local pinnedRetryAfter = nil

for index = 1, count do
  local offset = credentialOffset + ((index - 1) * 4)
  local id = ARGV[offset + 1]
  local rpmLimit = tonumber(ARGV[offset + 2])
  local concurrencyLimit = tonumber(ARGV[offset + 3])
  local priority = tonumber(ARGV[offset + 4])
  local state = parseState(rawStates[index + 1])
  state.id = id
  states[index] = state

  local blocked = false
  local candidateRetry = 1
  if state.cooldown > now then
    blocked = true
    local cooldownRetry = math.ceil((state.cooldown - now) / 1000)
    if cooldownRetry > candidateRetry then candidateRetry = cooldownRetry end
  end
  if state.rpm >= rpmLimit then
    blocked = true
    if state.oldestRpmExpiry then
      local rpmRetry = math.ceil((state.oldestRpmExpiry - now) / 1000)
      if rpmRetry > candidateRetry then candidateRetry = rpmRetry end
    end
  end
  if #state.leases >= concurrencyLimit then
    blocked = true
    if state.oldestLeaseExpiry then
      local leaseRetry = math.ceil((state.oldestLeaseExpiry - now) / 1000)
      if leaseRetry > candidateRetry then candidateRetry = leaseRetry end
    end
  end

  local usable = state.cooldown <= now and state.rpm < rpmLimit and #state.leases < concurrencyLimit
  if blocked and (retryAfter == nil or candidateRetry < retryAfter) then retryAfter = candidateRetry end
  if blocked and id == pinned then pinnedRetryAfter = candidateRetry end
  if id == pinned and usable then pinnedIndex = index end
  if usable then
    local load = math.max(state.rpm / rpmLimit, #state.leases / concurrencyLimit)
    if bestScore == nil or load < bestScore or (load == bestScore and (bestPriority == nil or priority > bestPriority)) then
      bestScore = load
      bestPriority = priority
      bestIndex = index
    end
  end
end

local selected = pinnedIndex or bestIndex
if pinned ~= false and pinned ~= nil and pinned ~= "" and pinnedIndex == nil and hard then
  return {"hard-unavailable", pinned, tostring(pinnedRetryAfter or 1)}
end
if selected == nil then return {"capacity", tostring(retryAfter or 1)} end

if budgetKeyIndex > 0 then
  local budgetOffset = credentialOffset + (count * 4)
  local limit = math.max(0, tonumber(ARGV[budgetOffset + 1]) or 0)
  local reservation = math.max(0, tonumber(ARGV[budgetOffset + 2]) or 0)
  local initialSpent = math.max(0, tonumber(ARGV[budgetOffset + 3]) or 0)
  local budgetTtl = math.max(1, tonumber(ARGV[budgetOffset + 4]) or 60)
  local budgetLeaseTtlMs = math.max(1000, tonumber(ARGV[budgetOffset + 5]) or 1000)
  local budgetKey = KEYS[budgetKeyIndex]
  local rawBudget = redis.call("GET", budgetKey)
  local committed = initialSpent
  local leaseRaw = ""
  if rawBudget then
    local committedText, leasesText = string.match(rawBudget, "^([^|]*)|(.*)$")
    if committedText ~= nil then
      local storedCommitted = tonumber(committedText) or initialSpent
      committed = math.max(storedCommitted, initialSpent)
      leaseRaw = leasesText or ""
    else
      local storedCommitted = tonumber(rawBudget) or initialSpent
      committed = math.max(storedCommitted, initialSpent)
    end
  end
  local activeLeases = {}
  local reservedTotal = 0
  for entry in string.gmatch(leaseRaw, "([^;]+)") do
    local first = string.find(entry, ":", 1, true)
    local second = first and string.find(entry, ":", first + 1, true) or nil
    if first and second then
      local id = string.sub(entry, 1, first - 1)
      local amount = tonumber(string.sub(entry, first + 1, second - 1)) or 0
      local expiry = tonumber(string.sub(entry, second + 1)) or 0
      if id ~= "" and expiry > now then
        activeLeases[#activeLeases + 1] = entry
        reservedTotal = reservedTotal + amount
      end
    end
  end
  if committed + reservedTotal + reservation > limit then return {"budget", tostring(budgetTtl)} end
  activeLeases[#activeLeases + 1] = leaseId .. ":" .. tostring(reservation) .. ":" .. tostring(now + budgetLeaseTtlMs)
  redis.call("SET", budgetKey, tostring(committed) .. "|" .. table.concat(activeLeases, ";"), "EX", budgetTtl)
end

local state = states[selected]
local foundBucket = false
for index = 1, #state.buckets do
  if state.buckets[index].start == currentRpmBucket then
    state.buckets[index].count = state.buckets[index].count + 1
    foundBucket = true
    break
  end
end
if not foundBucket then state.buckets[#state.buckets + 1] = { start = currentRpmBucket, count = 1 } end
state.leases[#state.leases + 1] = { id = leaseId, expiry = now + leaseTtlMs, rpmBucket = currentRpmBucket }

local hsetArguments = { state.id, encodeState(state) }
if shouldTouchState then
  hsetArguments[#hsetArguments + 1] = "_touch"
  hsetArguments[#hsetArguments + 1] = tostring(now + stateTouchIntervalMs)
end
redis.call("HSET", KEYS[1], unpack(hsetArguments))
if shouldTouchState then redis.call("EXPIRE", KEYS[1], stateTtl) end
if affinityIndex > 0 and (refreshAffinity or sessionCredential ~= state.id) then
  redis.call("SET", affinity, state.id, "EX", affinityTtl)
end
return {"ok", state.id, pinnedIndex and "sticky" or "new"}
`

const releaseScript = `
local status = tonumber(ARGV[1])
local retryAfter = tonumber(ARGV[2])
local leaseId = ARGV[3]
local credentialId = ARGV[4]
local now = tonumber(ARGV[5])
local stateTtl = tonumber(ARGV[6])
local stateTouchIntervalMs = tonumber(ARGV[7])
local hasBudget = ARGV[8] == "1"
local actual = math.max(0, tonumber(ARGV[9]) or 0)
local budgetTtl = tonumber(ARGV[10]) or 60
local rpmRetentionMs = 61000

local raw = redis.call("HGET", KEYS[1], credentialId)
local stateChanged = false
local cooldownText = "0"
local rpmRaw = ""
local leasesRaw = ""
if raw and raw ~= "" then
  local parsedCooldown, parsedRpm, parsedLeases = string.match(raw, "^([^|]*)|([^|]*)|(.*)$")
  if parsedCooldown ~= nil then
    cooldownText = parsedCooldown ~= "" and parsedCooldown or "0"
    rpmRaw = parsedRpm or ""
    leasesRaw = parsedLeases or ""
  end
end

local targetRpmBucket = nil
local keptLeases = {}
for entry in string.gmatch(leasesRaw, "([^;]+)") do
  local first = string.find(entry, ":", 1, true)
  local second = first and string.find(entry, ":", first + 1, true) or nil
  if first and second then
    local id = string.sub(entry, 1, first - 1)
    local expiry = tonumber(string.sub(entry, first + 1, second - 1)) or 0
    local rpmBucket = tonumber(string.sub(entry, second + 1))
    if id == leaseId then
      targetRpmBucket = rpmBucket
      stateChanged = true
    elseif expiry > now then
      keptLeases[#keptLeases + 1] = entry
    else
      stateChanged = true
    end
  end
end

local keptBuckets = {}
for entry in string.gmatch(rpmRaw, "([^;]+)") do
  local separator = string.find(entry, ":", 1, true)
  if separator then
    local bucketStart = tonumber(string.sub(entry, 1, separator - 1))
    local bucketCount = tonumber(string.sub(entry, separator + 1)) or 0
    if bucketStart and bucketCount > 0 and bucketStart + rpmRetentionMs > now then
      if status == 429 and targetRpmBucket and bucketStart == targetRpmBucket then
        bucketCount = bucketCount - 1
        targetRpmBucket = nil
        stateChanged = true
      end
      if bucketCount > 0 then keptBuckets[#keptBuckets + 1] = tostring(bucketStart) .. ":" .. tostring(bucketCount) end
    else
      stateChanged = true
    end
  end
end

local needsExpiry = false
local cooldown = tonumber(cooldownText) or 0
if status == 429 or status >= 500 then
  local requestedCooldown = now + (retryAfter * 1000)
  if requestedCooldown > cooldown then cooldown = requestedCooldown end
  stateChanged = true
  needsExpiry = true
elseif cooldown <= now then
  cooldown = 0
end

if stateChanged or (not raw and (status == 429 or status >= 500)) then
  local hsetArguments = {
    credentialId,
    tostring(cooldown) .. "|" .. table.concat(keptBuckets, ";") .. "|" .. table.concat(keptLeases, ";"),
  }
  if not raw then
    hsetArguments[#hsetArguments + 1] = "_touch"
    hsetArguments[#hsetArguments + 1] = tostring(now + stateTouchIntervalMs)
    needsExpiry = true
  end
  redis.call("HSET", KEYS[1], unpack(hsetArguments))
end
if needsExpiry then redis.call("EXPIRE", KEYS[1], stateTtl) end

if hasBudget then
  local rawBudget = redis.call("GET", KEYS[2])
  if rawBudget then
    local committedText, leaseRaw = string.match(rawBudget, "^([^|]*)|(.*)$")
    local committed = tonumber(committedText or rawBudget) or 0
    local kept = {}
    local reserved = nil
    for entry in string.gmatch(leaseRaw or "", "([^;]+)") do
      local first = string.find(entry, ":", 1, true)
      local second = first and string.find(entry, ":", first + 1, true) or nil
      if first and second then
        local id = string.sub(entry, 1, first - 1)
        local amount = tonumber(string.sub(entry, first + 1, second - 1)) or 0
        local expiry = tonumber(string.sub(entry, second + 1)) or 0
        if id == leaseId then
          reserved = amount
        elseif expiry > now then
          kept[#kept + 1] = entry
        end
      end
    end
    if reserved ~= nil then
      committed = math.max(0, committed + actual)
      redis.call("SET", KEYS[2], tostring(committed) .. "|" .. table.concat(kept, ";"), "EX", budgetTtl)
    end
  end
end
return {"ok"}
`

const budgetReserveScript = `
local limit = math.max(0, tonumber(ARGV[1]) or 0)
local initialSpent = math.max(0, tonumber(ARGV[2]) or 0)
local reservation = math.max(0, tonumber(ARGV[3]) or 0)
local ttl = math.max(1, tonumber(ARGV[4]) or 60)
local leaseId = ARGV[5]
local now = tonumber(ARGV[6])
local leaseTtlMs = math.max(1000, tonumber(ARGV[7]) or 1000)
local raw = redis.call("GET", KEYS[1])
local committed = initialSpent
local leaseRaw = ""
if raw then
  local committedText, leasesText = string.match(raw, "^([^|]*)|(.*)$")
  if committedText ~= nil then
    local storedCommitted = tonumber(committedText) or initialSpent
    committed = math.max(storedCommitted, initialSpent)
    leaseRaw = leasesText or ""
  else
    local storedCommitted = tonumber(raw) or initialSpent
    committed = math.max(storedCommitted, initialSpent)
  end
end
local kept = {}
local reservedTotal = 0
for entry in string.gmatch(leaseRaw, "([^;]+)") do
  local first = string.find(entry, ":", 1, true)
  local second = first and string.find(entry, ":", first + 1, true) or nil
  if first and second then
    local id = string.sub(entry, 1, first - 1)
    local amount = tonumber(string.sub(entry, first + 1, second - 1)) or 0
    local expiry = tonumber(string.sub(entry, second + 1)) or 0
    if id ~= "" and expiry > now then
      kept[#kept + 1] = entry
      reservedTotal = reservedTotal + amount
    end
  end
end
if committed + reservedTotal + reservation > limit then return {"budget", tostring(ttl)} end
kept[#kept + 1] = leaseId .. ":" .. tostring(reservation) .. ":" .. tostring(now + leaseTtlMs)
redis.call("SET", KEYS[1], tostring(committed) .. "|" .. table.concat(kept, ";"), "EX", ttl)
return {"ok", leaseId}
`

const budgetSettleScript = `
local actual = math.max(0, tonumber(ARGV[1]) or 0)
local ttl = tonumber(ARGV[2]) or 60
local leaseId = ARGV[3]
local now = tonumber(ARGV[4])
local raw = redis.call("GET", KEYS[1])
if not raw then return {"already-settled"} end
local committedText, leaseRaw = string.match(raw, "^([^|]*)|(.*)$")
if committedText == nil then return {"already-settled"} end
local committed = tonumber(committedText) or 0
local kept = {}
local reserved = nil
for entry in string.gmatch(leaseRaw or "", "([^;]+)") do
  local first = string.find(entry, ":", 1, true)
  local second = first and string.find(entry, ":", first + 1, true) or nil
  if first and second then
    local id = string.sub(entry, 1, first - 1)
    local amount = tonumber(string.sub(entry, first + 1, second - 1)) or 0
    local expiry = tonumber(string.sub(entry, second + 1)) or 0
    if id == leaseId then
      reserved = amount
    elseif expiry > now then
      kept[#kept + 1] = entry
    end
  end
end
if reserved == nil then return {"already-settled"} end
committed = math.max(0, committed + actual)
redis.call("SET", KEYS[1], tostring(committed) .. "|" .. table.concat(kept, ";"), "EX", ttl)
return {"ok"}
`

const renewScript = `
local credentialId = ARGV[1]
local leaseId = ARGV[2]
local leaseTtlMs = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local stateTtl = tonumber(ARGV[5])
local stateTouchIntervalMs = tonumber(ARGV[6])
local rawState = redis.call("HMGET", KEYS[1], credentialId, "_touch")
local raw = rawState[1]
if not raw then return 0 end
local cooldown, rpmRaw, leasesRaw = string.match(raw, "^([^|]*)|([^|]*)|(.*)$")
if cooldown == nil then return 0 end
local leases = {}
local found = false
for entry in string.gmatch(leasesRaw or "", "([^;]+)") do
  local first = string.find(entry, ":", 1, true)
  local second = first and string.find(entry, ":", first + 1, true) or nil
  if first and second then
    local id = string.sub(entry, 1, first - 1)
    local expiry = tonumber(string.sub(entry, first + 1, second - 1)) or 0
    local rpmBucket = string.sub(entry, second + 1)
    if id == leaseId then
      leases[#leases + 1] = id .. ":" .. tostring(now + leaseTtlMs) .. ":" .. rpmBucket
      found = true
    elseif expiry > now then
      leases[#leases + 1] = entry
    end
  end
end
if not found then return 0 end
local hsetArguments = {
  credentialId,
  (cooldown or "0") .. "|" .. (rpmRaw or "") .. "|" .. table.concat(leases, ";"),
}
local nextTouchAt = tonumber(rawState[2]) or 0
if nextTouchAt <= now then
  hsetArguments[#hsetArguments + 1] = "_touch"
  hsetArguments[#hsetArguments + 1] = tostring(now + stateTouchIntervalMs)
end
redis.call("HSET", KEYS[1], unpack(hsetArguments))
if nextTouchAt <= now then redis.call("EXPIRE", KEYS[1], stateTtl) end
return 1
`

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback
}

function booleanSetting(value: string | undefined, fallback = false) {
  if (value === undefined) return fallback
  return value === "1" || value.toLowerCase() === "true"
}

export class RedisRoutingStateStore {
  private readonly prefix: string
  private readonly affinityTtlSeconds: number
  private readonly responseTtlSeconds: number
  private readonly inflightLeaseTtlSeconds: number
  private readonly stateTtlSeconds: number
  private readonly stateTouchIntervalSeconds: number
  private readonly refreshAffinityTtl: boolean
  private readonly defaultRpmLimit: number
  private readonly defaultMaxConcurrency: number
  private readonly reserveRunner: (keys: string[], args: Array<string | number>) => Promise<unknown>
  private readonly releaseRunner: (keys: string[], args: Array<string | number>) => Promise<unknown>
  private readonly renewRunner: (keys: string[], args: Array<string | number>) => Promise<unknown>
  private readonly budgetReserveRunner: (keys: string[], args: Array<string | number>) => Promise<unknown>
  private readonly budgetSettleRunner: (keys: string[], args: Array<string | number>) => Promise<unknown>

  constructor(private readonly redis: RoutingRedis, options: StoreOptions = {}) {
    this.prefix = options.prefix || process.env.ROUTING_STATE_PREFIX || "rawroute:routing:v2"
    this.affinityTtlSeconds = options.affinityTtlSeconds || positiveInteger(Number(process.env.ROUTING_AFFINITY_TTL_SECONDS), 3600)
    this.responseTtlSeconds = options.responseTtlSeconds || positiveInteger(Number(process.env.ROUTING_RESPONSE_TTL_SECONDS), 86400)
    this.inflightLeaseTtlSeconds = options.inflightLeaseTtlSeconds || positiveInteger(Number(process.env.ROUTING_INFLIGHT_LEASE_TTL_SECONDS), 900)
    const minimumStateTtl = this.inflightLeaseTtlSeconds + 120
    this.stateTtlSeconds = Math.max(minimumStateTtl, options.stateTtlSeconds || positiveInteger(Number(process.env.ROUTING_STATE_TTL_SECONDS), 7 * 24 * 60 * 60))
    const configuredTouchIntervalSeconds = Math.max(
      60,
      options.stateTouchIntervalSeconds || positiveInteger(Number(process.env.ROUTING_STATE_TOUCH_INTERVAL_SECONDS), 24 * 60 * 60),
    )
    const maximumLeaseSafeTouchIntervalSeconds = Math.max(60, this.stateTtlSeconds - this.inflightLeaseTtlSeconds - 60)
    this.stateTouchIntervalSeconds = Math.min(
      configuredTouchIntervalSeconds,
      Math.max(60, Math.floor(this.stateTtlSeconds / 2)),
      maximumLeaseSafeTouchIntervalSeconds,
    )
    this.refreshAffinityTtl = options.refreshAffinityTtl ?? booleanSetting(process.env.ROUTING_REFRESH_AFFINITY_TTL, false)
    this.defaultRpmLimit = positiveInteger(Number(process.env.ROUTING_DEFAULT_RPM_LIMIT), 60)
    this.defaultMaxConcurrency = positiveInteger(Number(process.env.ROUTING_DEFAULT_MAX_CONCURRENCY), 4)
    const reserveScriptRunner = redis.createScript?.(reserveScript)
    const releaseScriptRunner = redis.createScript?.(releaseScript)
    const renewScriptRunner = redis.createScript?.(renewScript)
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
    this.budgetReserveRunner = budgetReserveScriptRunner
      ? (keys, args) => budgetReserveScriptRunner.exec(keys, args.map(String))
      : (keys, args) => redis.eval(budgetReserveScript, keys, args)
    this.budgetSettleRunner = budgetSettleScriptRunner
      ? (keys, args) => budgetSettleScriptRunner.exec(keys, args.map(String))
      : (keys, args) => redis.eval(budgetSettleScript, keys, args)
  }

  private affinityScope(providerId: string, modelId: string) {
    return `${currentWorkspaceId()}:${providerId}:${modelId}`
  }

  private providerStateKey(providerId: string) {
    return `${this.prefix}:state:${currentWorkspaceId()}:${providerId}`
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
    if (!credentials.length) return { ok: false as const, reason: "capacity" as const, retryAfterSeconds: 1 }

    const affinityScope = this.affinityScope(input.providerId, input.modelId)
    const keys: string[] = [this.providerStateKey(input.providerId)]
    const leaseId = crypto.randomUUID()
    const args: Array<string | number> = [
      this.affinityTtlSeconds,
      credentials.length,
      input.hardAffinity ? 1 : 0,
      input.requiredCredentialId || "",
      leaseId,
      this.inflightLeaseTtlSeconds * 1000,
      0,
      0,
      0,
      Date.now(),
      this.stateTtlSeconds,
      this.stateTouchIntervalSeconds * 1000,
      this.refreshAffinityTtl ? 1 : 0,
    ]
    for (const credential of credentials) {
      args.push(
        credential.id,
        positiveInteger(credential.rpmLimit, this.defaultRpmLimit),
        positiveInteger(credential.maxConcurrency, this.defaultMaxConcurrency),
        Number.isFinite(credential.priority) ? Number(credential.priority) : 0,
      )
    }
    if (input.sessionKey) {
      keys.push(`${this.prefix}:affinity:${affinityScope}:${input.sessionKey}`)
      args[6] = keys.length
    }
    if (input.responseId) {
      keys.push(this.responseKey(input.providerId, input.responseId))
      args[7] = keys.length
    }
    if (input.budget) {
      keys.push(input.budget.key)
      args[8] = keys.length
      args.push(
        input.budget.limitMicros,
        input.budget.reservationMicros,
        input.budget.spentMicros,
        input.budget.ttlSeconds,
        this.inflightLeaseTtlSeconds * 1000,
      )
    }
    const response = await this.reserveRunner(keys, args) as Array<string | number>
    if (response?.[0] === "ok") return { ok: true as const, credentialId: String(response[1]), affinity: String(response[2]), leaseId }
    if (response?.[0] === "hard-missing") {
      return { ok: false as const, reason: "hard-response-missing" as const, retryAfterSeconds: 1 }
    }
    if (response?.[0] === "hard-unavailable") {
      return { ok: false as const, reason: "hard-affinity-unavailable" as const, credentialId: String(response[1]), retryAfterSeconds: Number(response[2]) || 1 }
    }
    if (response?.[0] === "budget") return { ok: false as const, reason: "budget" as const, retryAfterSeconds: Number(response[1]) || 1 }
    return { ok: false as const, reason: "capacity" as const, retryAfterSeconds: Number(response?.[1]) || 1 }
  }

  async release(input: ReleaseInput) {
    const needsCooldown = input.status === 429 || input.status >= 500
    const retryAfter = needsCooldown ? positiveInteger(input.retryAfterSeconds, 5) : 0
    const keys = [this.providerStateKey(input.providerId)]
    if (input.budget) keys.push(input.budget.key)
    await this.releaseRunner(keys, [
      input.status,
      retryAfter,
      input.leaseId,
      input.credentialId,
      Date.now(),
      Math.max(this.stateTtlSeconds, retryAfter + 120),
      this.stateTouchIntervalSeconds * 1000,
      input.budget ? 1 : 0,
      input.budget?.actualMicros || 0,
      input.budget ? positiveInteger(input.budget.ttlSeconds, 60) : 0,
    ])
  }

  async reserveBudget(input: BudgetReservationInput) {
    const leaseId = crypto.randomUUID()
    const response = await this.budgetReserveRunner([input.key], [
      input.limitMicros,
      input.spentMicros,
      input.reservationMicros,
      input.ttlSeconds,
      leaseId,
      Date.now(),
      this.inflightLeaseTtlSeconds * 1000,
    ]) as Array<string | number>
    if (response?.[0] === "ok") return { ok: true as const, leaseId, reservationMicros: input.reservationMicros }
    return { ok: false as const, reason: "budget" as const, retryAfterSeconds: Number(response?.[1]) || input.ttlSeconds }
  }

  async settleBudget(input: { key: string; leaseId: string; actualMicros: number; ttlSeconds: number }) {
    await this.budgetSettleRunner([input.key], [input.actualMicros, input.ttlSeconds, input.leaseId, Date.now()])
  }

  async renew(input: { providerId: string; credentialId: string; leaseId: string }) {
    const response = await this.renewRunner([
      this.providerStateKey(input.providerId),
    ], [
      input.credentialId,
      input.leaseId,
      this.inflightLeaseTtlSeconds * 1000,
      Date.now(),
      this.stateTtlSeconds,
      this.stateTouchIntervalSeconds * 1000,
    ])
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

    const pipeline = uniqueResponseIds.length > 1 ? this.redis.pipeline?.() : undefined
    if (pipeline) {
      for (const responseId of uniqueResponseIds) {
        pipeline.set(this.responseKey(providerId, responseId), credentialId, { ex: this.responseTtlSeconds })
      }
      await pipeline.exec()
      return
    }
    await Promise.all(uniqueResponseIds.map((responseId) => (
      this.redis.set(this.responseKey(providerId, responseId), credentialId, { ex: this.responseTtlSeconds })
    )))
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
