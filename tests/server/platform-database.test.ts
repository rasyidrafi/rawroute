import { afterEach, expect, test } from "bun:test"
import { closeLocalDatabase, getDatabase, getSqliteDatabase, installDocumentIntegration } from "../../packages/platform/src/server/database"

process.env.SQLITE_PATH = ":memory:"
afterEach(closeLocalDatabase)

test("neutral document persistence initializes without gateway schemas or integrations", async () => {
  const document = getSqliteDatabase().collection("platform_records").doc("workspace")
  await document.set({ name: "Example" })
  expect((await document.get()).data()).toEqual({ name: "Example" })
  const tables = getDatabase().query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name)
  expect(tables).toEqual(["rawroute_documents"])
})

test("contributed persistence writes share document commit and rollback", async () => {
  installDocumentIntegration({
    initialize(database) { database.run("CREATE TABLE IF NOT EXISTS test_projection (id TEXT PRIMARY KEY, value INTEGER)") },
    validateCollection() {},
    tracks: collection => collection === "events",
    changed(database, _collection, path, _before, after) {
      database.run("INSERT OR REPLACE INTO test_projection VALUES (?, ?)", [path, Number(after?.value || 0)])
      if (after?.reject) throw new Error("projection failed")
    },
    async deletingTree() {},
  })
  const event = getSqliteDatabase().collection("events").doc("one")
  await event.set({ value: 1 })
  await expect(event.set({ value: 2, reject: true })).rejects.toThrow("projection failed")
  expect((await event.get()).data()).toEqual({ value: 1 })
  expect(getDatabase().query<{ value: number }, []>("SELECT value FROM test_projection").get()?.value).toBe(1)
  const batch = getSqliteDatabase().batch()
  batch.set(event, { value: 3 })
  batch.set(getSqliteDatabase().collection("events").doc("two"), { value: 4, reject: true })
  await expect(batch.commit()).rejects.toThrow("projection failed")
  expect((await event.get()).data()).toEqual({ value: 1 })
  expect(getDatabase().query<{ value: number }, []>("SELECT value FROM test_projection").all()).toEqual([{ value: 1 }])
})
