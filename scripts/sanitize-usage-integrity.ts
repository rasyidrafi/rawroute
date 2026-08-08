import { createHash } from "node:crypto"
import { closeLocalDatabase, listLocalDocuments, upsertLocalDocuments } from "@/lib/local-db"
import { startOfZonedDay, startOfZonedHour, startOfZonedMonth } from "@/lib/timezone"
import type { UsageEvent, UsageRollup } from "@/lib/types"

/** Exclude failed requests from pricing-confidence counters without changing request volume or billed cost. */

const apply = process.argv.includes("--apply")
const prefix = (process.env.DATABASE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")

function isEventCollection(path: string) {
  return path === `${prefix}_usage_events` || path.endsWith("/usageEvents")
}

function rollupCollectionPath(eventPath: string) {
  if (eventPath === `${prefix}_usage_events`) return `${prefix}_usage_rollups`
  if (eventPath.endsWith("/usageEvents")) return `${eventPath.slice(0, -"usageEvents".length)}usageRollups`
  return undefined
}

function rollupPath(collectionPath: string, granularity: UsageRollup["granularity"], bucket: string, event: UsageEvent) {
  const suffix = createHash("sha256").update(`${event.gatewayKeyId}:${event.gatewayModelId}`).digest("hex").slice(0, 24)
  return `${collectionPath}/${granularity}:${bucket}:${suffix}`
}

function number(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0
}

function bucketStart(completedAt: string, granularity: UsageRollup["granularity"]) {
  const date = new Date(completedAt)
  if (granularity === "hourly") return startOfZonedHour(date).toISOString()
  if (granularity === "daily") return startOfZonedDay(date).toISOString()
  return startOfZonedMonth(date).toISOString()
}

async function main() {
  const documents = await listLocalDocuments()
  const byPath = new Map(documents.map((document) => [document.path, document]))
  const updates = new Map<string, object>()
  const adjustedEvents = new Set<string>()
  for (const document of documents.filter((candidate) => isEventCollection(candidate.collection_path))) {
    const event = document.data as unknown as UsageEvent
    if (event.status >= 200 && event.status < 300) continue
    const collectionPath = rollupCollectionPath(document.collection_path)
    if (!collectionPath) continue
    for (const granularity of ["hourly", "daily", "monthly"] as const) {
      const path = rollupPath(collectionPath, granularity, bucketStart(event.completedAt, granularity), event)
      const existing = byPath.get(path)
      if (!existing) continue
      const previous = updates.get(path)
      const source = (previous || existing.data) as Record<string, unknown>
      const existingExcluded = Array.isArray(source.excludedEventIds) ? source.excludedEventIds.filter((value): value is string => typeof value === "string") : []
      const alreadyExcluded = existingExcluded.includes(event.id)
      const excludedEventIds = alreadyExcluded ? existingExcluded : [...existingExcluded, event.id]
      if (alreadyExcluded && number(source.failedRequests) >= excludedEventIds.length) continue
      const next = { ...source, excludedEventIds, failedRequests: Math.max(number(source.failedRequests), excludedEventIds.length), updatedAt: new Date().toISOString() } as Record<string, unknown>
      if (!alreadyExcluded) {
        if (event.pricingConfidence === "exact") next.pricedRequests = Math.max(0, number(source.pricedRequests) - 1)
        else next.unpricedRequests = Math.max(0, number(source.unpricedRequests) - 1)
      }
      updates.set(path, next)
      if (!alreadyExcluded) adjustedEvents.add(event.id)
    }
  }

  if (apply && updates.size) await upsertLocalDocuments([...updates.entries()].map(([path, data]) => ({ path, data })))
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", rollupRows: updates.size, adjustedEvents: adjustedEvents.size, paths: [...updates.keys()] }, null, 2))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}).finally(() => closeLocalDatabase())
