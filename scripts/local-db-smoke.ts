import { FieldValue, closeLocalDatabase, getSqliteDatabase, queryLocalUsageRange } from "@/lib/local-db"
import { recordUsageEvent } from "@/lib/analytics"
import type { UsageEvent } from "@/lib/types"
import { runInWorkspace } from "@/lib/workspace/context"

const collection = `rawroute_local_smoke_${process.pid}`
const db = getSqliteDatabase()
const documents = db.collection(collection)
const counter = documents.doc("counter")
const prefix = (process.env.DATABASE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")
const usageWorkspace = db.collection(`${prefix}_workspaces`).doc(collection)

async function verifyDuplicateUsage() {
  if (process.env.STORAGE_BACKEND === "memory" || process.env.NODE_ENV === "test") throw new Error("Usage smoke verification requires the SQLite backend.")
  const event: UsageEvent = {
    id: "duplicate-usage",
    gatewayKeyId: "smoke-key",
    gatewayModelId: "smoke/model",
    protocol: "openai-chat",
    startedAt: "2026-10-13T12:00:00.000Z",
    completedAt: "2026-10-13T12:00:01.000Z",
    status: 200,
    durationMs: 1000,
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 5,
    costMicros: 123,
    pricingConfidence: "exact",
    usageAvailable: true,
  }
  const context = { usageStartAt: "2026-10-13T00:00:00.000Z", windowEnd: "2026-10-14T00:00:00.000Z" }
  const readUsage = async () => {
    const [events, usage] = await Promise.all([
      usageWorkspace.collection("usageEvents").get(),
      queryLocalUsageRange(collection, context.usageStartAt, context.windowEnd),
    ])
    return {
      events: events.docs.map((doc) => doc.data()),
      totals: usage.totals,
    }
  }
  await runInWorkspace({ id: collection, storageMode: "scoped" }, async () => {
    await recordUsageEvent(event, context)
    const original = await readUsage()
    if (original.events.length !== 1 || original.totals.requests !== 1 || original.totals.costMicros !== 123 || original.totals.totalTokens !== 5 || original.totals.successfulCostMicros !== 123) throw new Error("Usage event did not persist its canonical projection correctly.")
    await recordUsageEvent({ ...event, costMicros: 999 }, context)
    await Promise.all(Array.from({ length: 4 }, () => recordUsageEvent(event, context)))
    if (JSON.stringify(await readUsage()) !== JSON.stringify(original)) throw new Error("Duplicate usage recording changed persisted events or canonical projection.")
  })
}

async function main() {
  try {
    await counter.set({ count: 0, label: "initial" })
    let duplicateRejected = false
    try {
      await counter.create({ count: 999 })
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "DOCUMENT_EXISTS") throw error
      duplicateRejected = true
    }
    if (!duplicateRejected || (await counter.get()).data()?.count !== 0) throw new Error("Duplicate creation did not preserve the original document.")
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(counter)
      if (!snapshot.exists) throw new Error("Smoke document was not created.")
      transaction.update(counter, { count: FieldValue.increment(1) })
    })
    const batch = db.batch()
    batch.set(documents.doc("z-last"), { count: 3, label: "last" })
    batch.set(documents.doc("a-first"), { count: 2, label: "first" })
    batch.set(documents.doc("m-ten"), { count: 10, label: "ten", tags: ["alpha", "beta"] })
    await batch.commit()

    const queried = await documents.where("count", ">=", 2).orderBy("label", "asc").get()
    const selected = await documents.where("count", "in", [3, 10]).get()
    const tagged = await documents.where("tags", "array-contains", "beta").get()
    const taggedAny = await documents.where("tags", "array-contains-any", ["missing", "alpha"]).get()
    await Promise.all(Array.from({ length: 8 }, () => db.runTransaction(async (transaction) => {
      transaction.update(counter, { count: FieldValue.increment(1) })
    })))
    const current = await counter.get()
    if (current.data()?.count !== 9) throw new Error("Concurrent transactional increments were not serialized correctly.")
    if (queried.docs.length !== 3 || queried.docs[0]?.id !== "a-first" || queried.docs[2]?.id !== "m-ten") throw new Error("Local numeric query/order behavior is incorrect.")
    if (selected.size !== 2 || tagged.size !== 1 || taggedAny.size !== 1) throw new Error("Local membership query behavior is incorrect.")
    const siblingPath = collection.replace("_", "X")
    const sibling = db.collection(siblingPath).doc("must-survive")
    await sibling.set({ keep: true })
    await db.recursiveDelete(documents)
    if (!(await sibling.get()).exists) throw new Error("Recursive delete matched a wildcard sibling path.")
    await sibling.delete()
    await verifyDuplicateUsage()
    console.log(JSON.stringify({ ok: true, collection, queried: queried.docs.map((doc) => doc.id), selected: selected.docs.map((doc) => doc.id), tagged: tagged.docs.map((doc) => doc.id), count: current.data()?.count }, null, 2))
  } finally {
    await db.recursiveDelete(usageWorkspace)
    await db.recursiveDelete(documents)
    await closeLocalDatabase()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
