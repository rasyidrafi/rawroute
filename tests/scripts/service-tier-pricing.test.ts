import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { migrateServiceTierPricing } from "../../scripts/migrations/service-tier-pricing"
import { hasServiceTierSchema } from "../../packages/gateway-ai/src/server/service-tier-schema"

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })
const model = { cost: { text: { input: { price: 10 }, output: { price: 50 } }, multipliers: [{ when: { service_tier: { equals: "priority" } }, factor: 2 }] } }
const catalog = { openai: { models: { astra: model } }, edenai: { models: { "openai/astra": model } } }

test("offline migration repairs reseller links, preserves history, validates backup and is idempotent", () => {
  directory = mkdtempSync(join(tmpdir(), "service-tier-"))
  const file = join(directory, "test.sqlite")
  const db = new Database(file)
  db.run("CREATE TABLE rawroute_documents(path TEXT PRIMARY KEY, collection_path TEXT, document_id TEXT, data TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
  const insert = (collection: string, id: string, data: unknown) => db.run("INSERT INTO rawroute_documents(path,collection_path,document_id,data) VALUES(?,?,?,?)", [`rawroute_workspaces/w/${collection}/${id}`, `rawroute_workspaces/w/${collection}`, id, JSON.stringify(data)])
  insert("modelPricingGroups", "g", { id: "g", canonicalSource: "models.dev", canonicalModelId: "openai/astra", canonicalProvider: "edenai" })
  insert("modelPricingGroups", "ambiguous", { id: "ambiguous", canonicalSource: "models.dev", canonicalModelId: "openai/astra" })
  insert("modelPricingVersions", "old", { id: "old", groupId: "g", version: 1, effectiveAt: "2020-01-01", inputMicrosPerMillion: 123, contextTiers: [] })
  insert("usageEvents", "historical", { costMicros: 987, requestedModel: "astra" })
  db.close()
  const before = readFileSync(file)
  expect(migrateServiceTierPricing(file, catalog)).toMatchObject({ applied: false, addedVersions: 1, detachedLinks: ["rawroute_workspaces/w/modelPricingGroups/ambiguous"] })
  expect(readFileSync(file)).toEqual(before)
  expect(() => migrateServiceTierPricing(file, catalog, { apply: true })).toThrow("Stop all writers")
  expect(() => migrateServiceTierPricing(file, catalog, { apply: true, writersStopped: true, backup: file })).toThrow("overwrite")
  const backup = join(directory, "backup.sqlite")
  expect(migrateServiceTierPricing(file, catalog, { apply: true, writersStopped: true, backup })).toMatchObject({ applied: true, addedVersions: 1 })
  const converted = new Database(file)
  const copy = new Database(backup)
  try {
    expect(hasServiceTierSchema(converted)).toBe(true)
    expect(hasServiceTierSchema(copy)).toBe(false)
    const rows = converted.query<{ data: string; document_id: string; collection_path: string }, []>("SELECT * FROM rawroute_documents").all()
    const get = (id: string) => JSON.parse(rows.find(row => row.document_id === id)!.data)
    expect(get("g").canonicalModelId).toBe("edenai/openai/astra")
    expect(get("ambiguous").canonicalModelId).toBeUndefined()
    expect(get("old")).toMatchObject({ inputMicrosPerMillion: 123, serviceTiers: [] })
    expect(get("historical")).toEqual({ costMicros: 987, requestedModel: "astra" })
    const versions = rows.filter(row => row.collection_path.endsWith("modelPricingVersions")).map(row => JSON.parse(row.data))
    expect(versions.find(version => version.id !== "old")).toMatchObject({ version: 2, inputMicrosPerMillion: 123, serviceTiers: [{ serviceTier: "priority", inputMicrosPerMillion: 20_000_000 }] })
  } finally { converted.close(); copy.close() }
  expect(migrateServiceTierPricing(file, catalog, { apply: true, writersStopped: true })).toEqual({ applied: false, required: false })
})

test("v1 upgrade preserves provider-scoped catalog links, custom schedules and historical usage", () => {
  directory = mkdtempSync(join(tmpdir(), "service-tier-v2-"))
  const file = join(directory, "test.sqlite")
  const db = new Database(file)
  db.run("CREATE TABLE rawroute_documents(path TEXT PRIMARY KEY, collection_path TEXT, document_id TEXT, data TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
  db.run("CREATE TABLE ai_service_tier_schema(id INTEGER PRIMARY KEY, version INTEGER)")
  db.run("INSERT INTO ai_service_tier_schema VALUES (1,1)")
  const group = { id: "g", canonicalSource: "models.dev", canonicalProvider: "edenai", canonicalModelId: "edenai/openai/astra" }
  const version = { id: "v", groupId: "g", serviceTiers: [{ serviceTier: "priority", inputMicrosPerMillion: 123, contextTiers: [] }] }
  for (const [collection, id, value] of [["modelPricingGroups", "g", group], ["modelPricingVersions", "v", version], ["usageEvents", "event", { costMicros: 100, requestedServiceTier: "priority" }]] as const) {
    db.run("INSERT INTO rawroute_documents(path,collection_path,document_id,data) VALUES(?,?,?,?)", [`rawroute_workspaces/w/${collection}/${id}`, `rawroute_workspaces/w/${collection}`, id, JSON.stringify(value)])
  }
  db.close()
  const before = readFileSync(file)
  expect(migrateServiceTierPricing(file, catalog)).toMatchObject({ required: true, addedVersions: 0, detachedLinks: [] })
  expect(readFileSync(file)).toEqual(before)
  expect(migrateServiceTierPricing(file, catalog, { apply: true, writersStopped: true, backup: join(directory, "backup") })).toMatchObject({ applied: true })
  const result = new Database(file)
  try {
    const rows = result.query<{ document_id: string; data: string }, []>("SELECT document_id,data FROM rawroute_documents").all()
    const get = (id: string) => JSON.parse(rows.find(row => row.document_id === id)!.data)
    expect(get("g")).toEqual(group)
    expect(get("v").serviceTiers).toEqual([{ ...version.serviceTiers[0], source: "custom" }])
    expect(get("event")).toEqual({ costMicros: 100, requestedServiceTier: "priority" })
    expect(hasServiceTierSchema(result)).toBe(true)
  } finally { result.close() }
  expect(migrateServiceTierPricing(file, catalog)).toEqual({ applied: false, required: false })
})

test("v2 upgrade removes only obsolete model settings and preserves rates, history and backup", () => {
  directory = mkdtempSync(join(tmpdir(), "service-tier-v3-"))
  const file = join(directory, "test.sqlite")
  const backup = join(directory, "backup.sqlite")
  const db = new Database(file)
  db.run("CREATE TABLE rawroute_documents(path TEXT PRIMARY KEY, collection_path TEXT, document_id TEXT, data TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
  db.run("CREATE TABLE ai_service_tier_schema(id INTEGER PRIMARY KEY, version INTEGER)")
  db.run("INSERT INTO ai_service_tier_schema VALUES (1,2)")
  const oldModel = { id: "m", name: "Model", enabled: false, reasoningCapability: { mode: "auto" }, serviceTierCapability: { profile: "anthropic", supportedTiers: ["fast"] } }
  const rows = [
    ["providers/p/models", "m", oldModel],
    ["modelPricingVersions", "v", { id: "v", serviceTiers: [{ serviceTier: "fast", source: "custom", multiplier: 6, inputMicrosPerMillion: 123, contextTiers: [] }] }],
    ["usageEvents", "e", { costMicros: 100, effectiveServiceTier: "fast" }],
  ] as const
  for (const [collection, id, value] of rows) db.run("INSERT INTO rawroute_documents(path,collection_path,document_id,data) VALUES(?,?,?,?)", [`rawroute_workspaces/w/${collection}/${id}`, `rawroute_workspaces/w/${collection}`, id, JSON.stringify(value)])
  db.close()
  const before = readFileSync(file)
  expect(migrateServiceTierPricing(file, {})).toMatchObject({ required: true, changedDocuments: 1, addedVersions: 0 })
  expect(readFileSync(file)).toEqual(before)
  expect(() => migrateServiceTierPricing(file, {}, { apply: true })).toThrow("Stop all writers")
  expect(migrateServiceTierPricing(file, {}, { apply: true, writersStopped: true, backup })).toMatchObject({ applied: true, changedDocuments: 1 })
  const converted = new Database(file)
  const copy = new Database(backup)
  try {
    const read = (database: Database, id: string) => JSON.parse(database.query<{ data: string }, [string]>("SELECT data FROM rawroute_documents WHERE document_id = ?").get(id)!.data)
    expect(read(converted, "m")).toEqual({ id: "m", name: "Model", enabled: false, reasoningCapability: { mode: "auto" } })
    expect(read(copy, "m")).toEqual(oldModel)
    for (const [, id, value] of rows.slice(1)) expect(read(converted, id)).toEqual(value)
    expect(hasServiceTierSchema(converted)).toBe(true)
    expect(hasServiceTierSchema(copy)).toBe(false)
  } finally { converted.close(); copy.close() }
  expect(migrateServiceTierPricing(file, {})).toEqual({ applied: false, required: false })
})
