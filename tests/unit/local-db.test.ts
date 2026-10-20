import { afterAll, expect, test } from "bun:test"
import { closeLocalDatabase, FieldValue, getSqliteDatabase } from "../../packages/platform/src/server/database"
import { initializeAiPersistence, queryLocalUsageRange } from "../../packages/gateway-ai/src/server/local-db"

import { recordUsageEvent } from "../../packages/gateway-ai/src/server/analytics"
import type { UsageEvent } from "../../packages/gateway-ai/src/contracts/domain"
import { runInWorkspace } from "../../packages/platform/src/server/workspace-context"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

initializeAiPersistence()
process.env.SQLITE_PATH = ":memory:"
const db = getSqliteDatabase()
afterAll(closeLocalDatabase)

test("async transactions serialize reads and writes without lost budget accounting", async () => {
  const counter = db.collection("budget-test").doc("counter")
  await counter.set({ spent: 0 })
  await Promise.all(Array.from({ length: 20 }, () => db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(counter)
    await Bun.sleep(1)
    transaction.set(counter, { spent: snapshot.data().spent + 1 })
  })))
  expect((await counter.get()).data().spent).toBe(20)
})

test("failed transactions and duplicate creates roll back all pending writes", async () => {
  const collection = db.collection("rollback-test")
  const existing = collection.doc("existing")
  const pending = collection.doc("pending")
  await existing.create({ count: 1 })
  const batch = db.batch()
  batch.set(pending, { count: 2 })
  batch.create(existing, { count: 3 })
  await expect(batch.commit()).rejects.toThrow("already exists")
  expect((await pending.get()).exists).toBe(false)
  expect((await existing.get()).data().count).toBe(1)
  await expect(db.runTransaction(async (transaction) => {
    transaction.update(existing, { count: FieldValue.increment(10) })
    throw new Error("abort")
  })).rejects.toThrow("abort")
  expect((await existing.get()).data().count).toBe(1)
})

test("numeric ranges, membership and literal recursive deletion", async () => {
  const collection = db.collection("query_test")
  await collection.doc("ten").set({ count: 10, tags: ["a", "b"] })
  await collection.doc("two").set({ count: 2 })
  expect((await collection.where("count", ">=", 2).orderBy("count").get()).docs.map(doc => doc.id)).toEqual(["two", "ten"])
  expect((await collection.where("tags", "array-contains", "b").get()).size).toBe(1)
  const sibling = db.collection("queryXtest").doc("keep")
  await sibling.set({ keep: true })
  await db.recursiveDelete(collection)
  expect((await sibling.get()).exists).toBe(true)
})

test("queries preserve JSON null, boolean and structural equality", async () => {
  const collection = db.collection("json-test")
  await collection.doc("null").set({ value: null })
  await collection.doc("true").set({ value: true })
  await collection.doc("one").set({ value: 1 })
  await collection.doc("object").set({ value: { z: 1, a: 2 }, tags: [{ z: 1, a: 2 }] })
  await collection.doc("missing").set({ other: 1 })
  expect((await collection.where("value", "==", null).get()).docs.map(doc => doc.id)).toEqual(["null"])
  expect((await collection.where("value", "==", true).get()).docs.map(doc => doc.id)).toEqual(["true"])
  expect((await collection.where("value", "in", [1]).get()).docs.map(doc => doc.id)).toEqual(["one"])
  expect((await collection.where("value", "==", { a: 2, z: 1 }).get()).size).toBe(1)
  expect((await collection.where("tags", "array-contains", { a: 2, z: 1 }).get()).size).toBe(1)
})

test("concurrent usage writes atomically account spend and deduplicate events", async () => {
  process.env.NODE_ENV = "production"
  process.env.STORAGE_BACKEND = "sqlite"
  const event: UsageEvent = {
    id: "base", gatewayKeyId: "key", gatewayModelId: "model", protocol: "openai-chat",
    startedAt: "2026-10-13T12:00:00.000Z", completedAt: "2026-10-13T12:00:01.000Z",
    status: 200, durationMs: 1000, inputTokens: 3, outputTokens: 2,
    cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 5, costMicros: 123,
    pricingConfidence: "exact", usageAvailable: true,
  }
  const context = { usageStartAt: "2026-10-13T00:00:00.000Z", windowEnd: "2026-10-14T00:00:00.000Z" }
  await runInWorkspace({ id: "atomic-usage", storageMode: "scoped" }, async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => recordUsageEvent({ ...event, id: `event-${index % 10}` }, context)))
    const root = db.collection("rawroute_workspaces").doc("atomic-usage")
    expect((await root.collection("usageEvents").get()).size).toBe(10)
    const counters = await root.collection("budgetCounters").get()
    expect(counters.size).toBe(0)
    expect((await queryLocalUsageRange("atomic-usage", context.usageStartAt, context.windowEnd)).totals).toMatchObject({ requests: 10, costMicros: 1230, successfulCostMicros: 1230 })
  })
})

test("SQLite persists committed documents across connection reopen", async () => {
  await closeLocalDatabase()
  const directory = mkdtempSync(join(tmpdir(), "rawroute-sqlite-"))
  process.env.SQLITE_PATH = join(directory, "documents.sqlite")
  try {
    const reference = db.collection("durable").doc("saved")
    await reference.set({ spentMicros: 123 })
    await closeLocalDatabase()
    expect((await reference.get()).data().spentMicros).toBe(123)
  } finally {
    await closeLocalDatabase()
    rmSync(directory, { recursive: true, force: true })
  }
})
