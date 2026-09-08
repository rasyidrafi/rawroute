import { createHash, randomUUID } from "node:crypto"

import { getLocalRedis } from "@/lib/local-redis"
import { currentWorkspaceId } from "@/lib/workspace-context"

const retentionMs = 8 * 24 * 60 * 60 * 1000
const leaseMs = 330_000

// State and probe ownership change atomically across gateway instances.
export const acquireScript = `
local raw = redis.call('get', KEYS[1])
if not raw then return {1, 0, 0} end
local s = cjson.decode(raw)
local now = tonumber(ARGV[1])
if s.probeUntil and s.probeUntil > now then return {0, s.probeUntil, s.failures} end
if s.retryAt > now and (not s.recoverAt or s.recoverAt > now) then return {0, s.retryAt, s.failures} end
s.token = ARGV[2]
s.probeUntil = now + tonumber(ARGV[3])
redis.call('set', KEYS[1], cjson.encode(s), 'PX', ARGV[4])
return {2, s.retryAt, s.failures}
`

export const settleScript = `
local raw = redis.call('get', KEYS[1])
local s = raw and cjson.decode(raw) or nil
if ARGV[1] ~= '' then
  if not s or s.token ~= ARGV[1] then return 0 end
elseif s then return 0 end
if ARGV[2] == '' then redis.call('del', KEYS[1])
else redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3]) end
return 1
`

export type CircuitTicket = { key: string; token: string; failures: number; retryAt: number; allowed: boolean; probe: boolean }

export async function acquireComboCircuit(model: string): Promise<CircuitTicket> {
  const key = `rawroute:combo-circuit:v1:${createHash("sha256").update(JSON.stringify([currentWorkspaceId(), model])).digest("hex")}`
  const token = randomUUID()
  try {
    const [mode, retryAt, failures] = await getLocalRedis().eval(acquireScript, 1, key, Date.now(), token, leaseMs, retentionMs) as number[]
    return { key, token: mode === 2 ? token : "", failures, retryAt, allowed: mode !== 0, probe: mode === 2 }
  } catch {
    // Redis outages preserve the original ordered fallback behavior.
    return { key, token: "", failures: 0, retryAt: 0, allowed: true, probe: false }
  }
}

export function retryTime(response: Response, failures: number, now = Date.now()) {
  const value = response.headers.get("retry-after")
  const seconds = value === null || !value.trim() ? NaN : Number(value)
  const date = value && !Number.isFinite(seconds) ? Date.parse(value) : NaN
  const explicit = Number.isFinite(seconds) ? now + seconds * 1000 : date
  const backoff = Math.min(300_000, 30_000 * 2 ** Math.min(failures, 4))
  return Number.isFinite(explicit) && explicit > now
    ? Math.min(now + retentionMs - leaseMs, explicit)
    : now + backoff
}

export async function settleComboCircuit(ticket: CircuitTicket, response?: Response, recoverable = false) {
  const retryable = response && !response.headers.has("x-rawroute-combo-terminal") &&
    !response.headers.has("x-rawroute-combo-member-unavailable") &&
    (response.status === 408 || response.status === 429 || response.status >= 500)
  const state = retryable ? JSON.stringify({
    failures: ticket.failures + 1,
    retryAt: retryTime(response, ticket.failures),
    // Check fresh Codex quota before a long upstream deadline, at most once/minute.
    ...(recoverable && response.status === 429 ? { recoverAt: Date.now() + 60_000 } : {}),
  }) : ""
  await getLocalRedis().eval(settleScript, 1, ticket.key, ticket.token, state, retentionMs).catch(() => undefined)
}
