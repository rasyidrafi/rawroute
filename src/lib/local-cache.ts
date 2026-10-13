import { LRUCache } from "lru-cache"

const cache = new LRUCache<string, string>({ max: 4096, maxSize: 16 * 1024 * 1024, sizeCalculation: (value, key) => Buffer.byteLength(value) + Buffer.byteLength(key) })
// Coordination entries are never evicted to make room for cached values.
const leases = new Map<string, { value: string; expiresAt: number }>()
const maximumLeases = 4096

function lease(key: string) {
  const entry = leases.get(key)
  if (entry && entry.expiresAt <= Date.now()) { leases.delete(key); return undefined }
  return entry
}

export async function localCacheGet(key: string) { return lease(key)?.value ?? cache.get(key) ?? null }
export async function localCacheSet(key: string, value: string, ttlMs: number) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false
  cache.set(key, value, { ttl: ttlMs })
  return cache.has(key)
}
export async function localCacheSetIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false
  if (lease(key) || cache.has(key)) return false
  for (const candidate of leases.keys()) lease(candidate)
  if (leases.size >= maximumLeases) throw new Error("In-process coordination capacity exceeded.")
  leases.set(key, { value, expiresAt: Date.now() + ttlMs })
  return true
}
export async function localCacheDelete(...keys: string[]) {
  for (const key of keys) { cache.delete(key); leases.delete(key) }
  return true
}
export async function localCacheCompareAndDelete(key: string, expectedValue: string) {
  if (lease(key)?.value !== expectedValue) return false
  leases.delete(key)
  return true
}
export async function closeLocalCache() { cache.clear(); leases.clear() }
