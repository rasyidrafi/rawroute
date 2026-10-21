import { afterEach, expect, test } from "bun:test"
import { closeLocalDatabase, getDatabase, getSqliteDatabase, installDocumentIntegration, installDocumentIntegrations, type DocumentIntegration } from "../../packages/platform/src/server/database"

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

test("explicit multi-owner composition preserves both hooks and rolls back all owners", async () => {
  const calls: string[] = []
  const owner = (name: string): DocumentIntegration => ({
    initialize(database) { database.run(`CREATE TABLE IF NOT EXISTS composition_${name} (path TEXT PRIMARY KEY, value INTEGER)`) },
    validateCollection(collection) {
      if (collection === "composition" && name === "storage") calls.push("validate-storage")
    },
    tracks: collection => collection === "composition",
    changed(database, _collection, path, before, after) {
      calls.push(`${name}:${String(before?.value)}:${String(after?.value)}`)
      if (after) database.run(`INSERT OR REPLACE INTO composition_${name} VALUES (?, ?)`, [path, Number(after.value)])
      else database.run(`DELETE FROM composition_${name} WHERE path = ?`, [path])
      if (name === "storage" && after?.reject) throw new Error("storage rejected")
    },
    async deletingTree(_database, prefix) { if (prefix === "composition") calls.push(`delete-${name}`) },
  })
  const ai = owner("ai")
  const storage = owner("storage")
  installDocumentIntegrations([ai, storage, ai])
  const document = getSqliteDatabase().collection("composition").doc("one")
  await document.set({ value: 1 })
  expect(calls).toEqual(["validate-storage", "ai:undefined:1", "storage:undefined:1"])
  // Reinstallation by standalone AI facilities must be harmless after open.
  installDocumentIntegration(ai)
  installDocumentIntegrations([storage, ai])
  await expect(document.set({ value: 2, reject: true })).rejects.toThrow("storage rejected")
  expect((await document.get()).data()).toEqual({ value: 1 })
  for (const name of ["ai", "storage"]) expect(getDatabase().query(`SELECT value FROM composition_${name}`).all()).toEqual([{ value: 1 }])
  await document.delete()
  expect(calls.slice(-3)).toEqual(["validate-storage", "ai:1:undefined", "storage:1:undefined"])
  await getSqliteDatabase().recursiveDelete(getSqliteDatabase().collection("composition"))
  expect(calls.slice(-2)).toEqual(["delete-ai", "delete-storage"])
})

test("composition cannot partially install a new owner after the database opens", async () => {
  await getSqliteDatabase().collection("late").doc("one").set({ value: 1 })
  const late: DocumentIntegration = {
    initialize() { throw new Error("late owner must not be installed") },
    validateCollection() {}, tracks: () => false, changed() {}, async deletingTree() {},
  }
  expect(() => installDocumentIntegrations([late])).toThrow("before opening")
  expect(() => installDocumentIntegration(late)).toThrow("before opening")
  await getSqliteDatabase().collection("late").doc("two").set({ value: 2 })
})
