import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Model, ModelPricingGroup, ModelPricingVersion } from "@rawroute/gateway-ai/contracts"
import { buildModelsDevCanonicalModels, createServiceTierSchema, hasServiceTierSchema, MODELS_DEV_URL } from "@rawroute/gateway-ai/server/maintenance/service-tier-pricing"
import { collectionPrefix } from "@rawroute/platform/server/storage-config"

type Row = { path: string; collection_path: string; document_id: string; data: string }
type Write = Omit<Row, "data"> & { data: Model | ModelPricingGroup | ModelPricingVersion }
type Options = { apply?: boolean; writersStopped?: boolean; backup?: string }

function plan(rows: Row[], catalog: Record<string, unknown>, prefix: string) {
  const models = buildModelsDevCanonicalModels(catalog)
  if (!models.length || !models.some(model => model.pricing.inputMicrosPerMillion > 0)) throw new Error("A models.dev v2 catalog snapshot is required")
  const now = new Date().toISOString()
  const writes: Write[] = []
  const detachedLinks: string[] = []
  let addedVersions = 0
  const versionRows = rows.filter(row => row.collection_path.startsWith(`${prefix}_workspaces/`) && row.collection_path.endsWith("/modelPricingVersions"))
  for (const row of versionRows) {
    const version = JSON.parse(row.data) as ModelPricingVersion
    if (version.serviceTiers === undefined) writes.push({ ...row, data: { ...version, serviceTiers: [] } })
  }
  for (const row of rows.filter(row => row.collection_path.startsWith(`${prefix}_workspaces/`) && row.collection_path.endsWith("/modelPricingGroups"))) {
    const group = JSON.parse(row.data) as ModelPricingGroup
    if (group.canonicalSource !== "models.dev" || !group.canonicalModelId) continue
    const candidates = models.filter(model => {
      const providerModelId = model.id.slice(model.provider.length + 1)
      const legacyId = providerModelId.includes("/") ? providerModelId : model.id
      return legacyId === group.canonicalModelId && (!group.canonicalProvider || model.provider === group.canonicalProvider)
    })
    const model = candidates.length === 1 ? candidates[0] : undefined
    if (!model) {
      // Do not guess which provider an ambiguous/removed legacy ID meant.
      const detached = { ...group, updatedAt: now }
      delete detached.canonicalModelId; delete detached.canonicalSource; delete detached.canonicalProvider; delete detached.canonicalModelName
      writes.push({ ...row, data: detached })
      detachedLinks.push(row.path)
      continue
    }
    if (model.id !== group.canonicalModelId || model.provider !== group.canonicalProvider) writes.push({ ...row, data: { ...group, canonicalModelId: model.id, canonicalProvider: model.provider, updatedAt: now } })
    const collection = row.collection_path.replace(/modelPricingGroups$/, "modelPricingVersions")
    const versions = versionRows.filter(entry => entry.collection_path === collection).map(entry => JSON.parse(entry.data) as ModelPricingVersion).filter(version => version.groupId === group.id)
    const current = versions.filter(version => version.effectiveAt <= now).sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt) || b.version - a.version)[0]
    if (!current || !model.serviceTiers?.length || current.serviceTiers?.length) continue
    const id = crypto.randomUUID()
    // Preserve custom Standard rates and old versions; new tier schedules start now.
    const version = { ...current, id, version: Math.max(...versions.map(entry => entry.version)) + 1, effectiveAt: now, createdAt: now, updatedAt: now, serviceTiers: model.serviceTiers }
    writes.push({ path: `${collection}/${id}`, collection_path: collection, document_id: id, data: version })
    addedVersions++
  }
  return { writes, detachedLinks, addedVersions }
}

/** No requests, credentials, historical costs, or inferred tiers are rewritten. */
export function migrateServiceTierPricing(file: string, catalog: Record<string, unknown>, options: Options = {}) {
  if (!file || !existsSync(file)) throw new Error("An explicit existing --sqlite path is required")
  if (options.apply && !options.writersStopped) throw new Error("Stop all writers and pass --writers-stopped before --apply")
  const database = new Database(file, options.apply ? { readwrite: true } : { readonly: true })
  try {
    if (hasServiceTierSchema(database)) return { applied: false, required: false }
    if (options.apply) {
      database.run("PRAGMA busy_timeout = 0")
      database.run("PRAGMA locking_mode = EXCLUSIVE")
      database.run("BEGIN EXCLUSIVE")
      database.run("COMMIT")
    }
    const rows = database.query<Row, []>("SELECT path, collection_path, document_id, data FROM rawroute_documents ORDER BY path").all()
    const previousSchema = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_service_tier_schema'").get()
    const previousVersion = previousSchema ? database.query<{ version: number }, []>("SELECT version FROM ai_service_tier_schema WHERE id = 1").get()?.version : undefined
    if (previousSchema && previousVersion !== 1 && previousVersion !== 2) throw new Error("Unsupported service tier schema version")
    const planned = previousSchema ? { writes: [] as Write[], detachedLinks: [] as string[], addedVersions: 0 } : plan(rows, catalog, collectionPrefix(database))
    // Preserve existing rates and history. Without provenance, treat old schedules
    // as user-owned; a catalog refresh must not replace them implicitly.
    for (const row of rows.filter(row => row.collection_path.endsWith("/modelPricingVersions"))) {
      const pending = planned.writes.find(write => write.path === row.path)
      const version = (pending?.data || JSON.parse(row.data)) as ModelPricingVersion
      if (!version.serviceTiers?.some(tier => !tier.source)) continue
      const data = { ...version, serviceTiers: version.serviceTiers.map(tier => ({ ...tier, source: tier.source || "custom" as const })) }
      if (pending) pending.data = data
      else planned.writes.push({ ...row, data })
    }
    // Retire per-model detection settings without touching pricing or request history.
    const workspacePrefix = `${collectionPrefix(database)}_workspaces/`
    for (const row of rows.filter(row => row.collection_path.startsWith(workspacePrefix) && /\/providers\/[^/]+\/models$/.test(row.collection_path))) {
      const data = JSON.parse(row.data) as Model & { serviceTierCapability?: unknown }
      if (!Object.hasOwn(data, "serviceTierCapability")) continue
      delete data.serviceTierCapability
      planned.writes.push({ ...row, data })
    }
    const report = { applied: false, required: true, changedDocuments: planned.writes.length, addedVersions: planned.addedVersions, detachedLinks: planned.detachedLinks }
    if (!options.apply) return report
    const backup = resolve(options.backup || `${file}.before-service-tier-pricing`)
    if (backup === resolve(file) || existsSync(backup)) throw new Error("Refusing to overwrite source or backup")
    const digest = (value: Row[]) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
    database.run("VACUUM INTO ?", [backup])
    chmodSync(backup, 0o600)
    const copy = new Database(backup, { readonly: true })
    try {
      if (copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok" || digest(copy.query<Row, []>("SELECT path, collection_path, document_id, data FROM rawroute_documents ORDER BY path").all()) !== digest(rows)) throw new Error("Backup validation failed")
    } finally { copy.close() }
    database.transaction(() => {
      const existing = new Set(rows.map(row => row.path))
      for (const row of planned.writes) {
        if (existing.has(row.path)) database.run("UPDATE rawroute_documents SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE path = ?", [JSON.stringify(row.data), row.path])
        else database.run("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?)", [row.path, row.collection_path, row.document_id, JSON.stringify(row.data)])
      }
      createServiceTierSchema(database)
    }).exclusive()
    return { ...report, applied: true, required: false, backup }
  } finally { database.close() }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  if (!args.includes("--sqlite") || !args.includes("--catalog")) throw new Error(`Required: --sqlite <stopped database> --catalog <snapshot of ${MODELS_DEV_URL}>; optional --apply --writers-stopped --backup <new file>`)
  console.log(JSON.stringify(migrateServiceTierPricing(value("--sqlite")!, JSON.parse(readFileSync(value("--catalog")!, "utf8")) as Record<string, unknown>, { apply: args.includes("--apply"), writersStopped: args.includes("--writers-stopped"), backup: args.includes("--backup") ? value("--backup") : undefined }), null, 2))
}
