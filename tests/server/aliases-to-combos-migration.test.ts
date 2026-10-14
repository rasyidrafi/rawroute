import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { migrateAliasesToCombos } from "../../scripts/migrations/aliases-to-combos"

test("offline alias migration preserves IDs, grants, fallback policies and a restorable backup", () => {
  const root = mkdtempSync("/tmp/opencode/routing-migration-")
  const file = join(root, "test.sqlite")
  const db = new Database(file)
  try {
    db.run("CREATE TABLE rawroute_documents (path TEXT PRIMARY KEY, collection_path TEXT, document_id TEXT, data TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
    const put = (collection: string, id: string, data: object) => db.run("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?)", [`rawroute_workspaces/one/${collection}/${id}`, `rawroute_workspaces/one/${collection}`, id, JSON.stringify(data)])
    const read = (collection: string, id: string) => JSON.parse(db.query<{ data: string }, [string]>("SELECT data FROM rawroute_documents WHERE path = ?").get(`rawroute_workspaces/one/${collection}/${id}`)!.data)
    put("aliases", "local", { alias: "stable", name: "Stable", targetModelId: "p/model", createdAt: "2026-01-01" })
    put("aliases", "shared", { alias: "shared", name: "Shared", targetModelId: "owner/p/model", sharedModelId: "grant", createdAt: "2026-01-02" })
    put("gatewayIds", Buffer.from("stable").toString("base64url"), { owner: "alias:local" })
    put("combos", "fallback", { combo: "fallback", name: "Fallback", members: [{ modelId: "stable", reasoning: { mode: "override", effort: "high" }, customPayload: { temperature: 0.5 } }, { modelId: "shared" }], createdAt: "2026-01-03" })
    expect(migrateAliasesToCombos(file)).toEqual({ aliases: 2, workspaces: 1, applied: false })
    expect(read("aliases", "local").alias).toBe("stable")
    expect(migrateAliasesToCombos(file, true).applied).toBe(true)
    expect(read("combos", "local")).toEqual({ combo: "stable", name: "Stable", members: [{ modelId: "p/model" }], createdAt: "2026-01-01" })
    expect(read("combos", "shared").members).toEqual([{ modelId: "owner/p/model", sharedModelId: "grant" }])
    expect(read("combos", "fallback").members).toEqual([{ modelId: "p/model", reasoning: { mode: "override", effort: "high" }, customPayload: { temperature: 0.5 } }, { modelId: "owner/p/model", sharedModelId: "grant" }])
    expect(read("gatewayIds", Buffer.from("stable").toString("base64url"))).toEqual({ owner: "combo:local" })
    expect(migrateAliasesToCombos(file, true)).toEqual({ aliases: 0, workspaces: 0, applied: false })
    const backup = new Database(`${file}.before-aliases-to-combos`, { readonly: true })
    try { expect(backup.query<{ count: number }, []>("SELECT count(*) as count FROM rawroute_documents WHERE collection_path LIKE '%/aliases'").get()!.count).toBe(2) }
    finally { backup.close() }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})

test("a conflicting workspace aborts the entire migration before any data changes", () => {
  const root = mkdtempSync("/tmp/opencode/routing-migration-")
  const file = join(root, "test.sqlite")
  const db = new Database(file)
  try {
    db.run("CREATE TABLE rawroute_documents (path TEXT PRIMARY KEY, collection_path TEXT, document_id TEXT, data TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
    for (const workspace of ["first", "conflict"]) {
      const collection = `rawroute_workspaces/${workspace}/aliases`
      db.run("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?)", [`${collection}/alias`, collection, "alias", JSON.stringify({ alias: "stable", name: "Stable", targetModelId: "p/model", createdAt: "2026-01-01" })])
    }
    const collection = "rawroute_workspaces/conflict/combos"
    db.run("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?)", [`${collection}/fallback`, collection, "fallback", JSON.stringify({ combo: "fallback", members: [{ modelId: "stable" }, { modelId: "p/model" }] })])
    const before = db.query("SELECT * FROM rawroute_documents ORDER BY path").all()
    expect(() => migrateAliasesToCombos(file, true)).toThrow("Remove duplicate targets before migrating")
    expect(db.query("SELECT * FROM rawroute_documents ORDER BY path").all()).toEqual(before)
    expect(existsSync(`${file}.before-aliases-to-combos`)).toBe(false)
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
