import { Database } from "bun:sqlite"
import { chmodSync, existsSync } from "node:fs"
import { join } from "node:path"
import { cleanAliasId } from "@rawroute/gateway-ai/server/maintenance/identifiers"
import type { ComboMember, ModelAlias, ModelCombo } from "@rawroute/gateway-ai/contracts"
import { collectionPrefix } from "@rawroute/platform/server/storage-config"

type StoredRow = { path: string; collection_path: string; document_id: string; data: string }
type Write = { path: string; collection: string; id: string; data: object }

/** Run with the server stopped. Plan every workspace before making an atomic, backed-up conversion. */
export function migrateAliasesToCombos(file: string, apply = false) {
  if (!existsSync(file)) throw new Error(`Database does not exist: ${file}`)
  const db = new Database(file, apply ? { readwrite: true } : { readonly: true })
  try {
    const prefix = collectionPrefix(db)
    const rows = db.query<StoredRow, []>("SELECT path, collection_path, document_id, data FROM rawroute_documents").all()
    const byPath = new Map(rows.map((row) => [row.path, row]))
    const aliasRows = rows.filter((row) => row.collection_path.startsWith(`${prefix}_workspaces/`) && row.collection_path.split("/").length === 3 && row.collection_path.endsWith("/aliases"))
    const writes: Write[] = []
    const deletes: string[] = []
    const roots = new Set(aliasRows.map((row) => row.collection_path.slice(0, -"/aliases".length)))
    for (const root of roots) {
      const aliases = aliasRows.filter((row) => row.collection_path === `${root}/aliases`)
      const targets = new Map<string, ComboMember>()
      for (const row of aliases) {
        const alias = JSON.parse(row.data) as ModelAlias
        if (!alias.alias || !alias.targetModelId) throw new Error(`Invalid alias: ${row.path}`)
        const member: ComboMember = { modelId: alias.targetModelId, ...(alias.sharedModelId ? { sharedModelId: alias.sharedModelId } : {}) }
        targets.set(alias.alias, member)
        const id = row.document_id
        const path = `${root}/combos/${id}`
        if (byPath.has(path)) throw new Error(`Combo ID collision: ${path}`)
        const gatewayId = Buffer.from(cleanAliasId(alias.alias)).toString("base64url")
        const reservationPath = `${root}/gatewayIds/${gatewayId}`
        const reservation = byPath.get(reservationPath)
        if (reservation && (JSON.parse(reservation.data) as { owner: string }).owner !== `alias:${id}`) throw new Error(`Gateway ID collision: ${alias.alias}`)
        if (rows.some((entry) => entry.collection_path === `${root}/combos` && (JSON.parse(entry.data) as ModelCombo).combo === alias.alias)) throw new Error(`Combo gateway ID collision: ${alias.alias}`)
        writes.push({ path, collection: `${root}/combos`, id, data: { combo: alias.alias, name: alias.name, members: [member], createdAt: alias.createdAt } })
        writes.push({ path: reservationPath, collection: `${root}/gatewayIds`, id: gatewayId, data: { owner: `combo:${id}` } })
        deletes.push(row.path)
      }
      for (const row of rows.filter((entry) => entry.collection_path === `${root}/combos`)) {
        const combo = JSON.parse(row.data) as ModelCombo
        if (!Array.isArray(combo.members)) throw new Error(`Invalid combo members: ${row.path}`)
        let changed = false
        const members = combo.members.map((member) => {
          const target = !member.sharedModelId ? targets.get(member.modelId) : undefined
          if (!target) return member
          changed = true
          return { ...member, ...target, validation: undefined }
        })
        if (!changed) continue
        if (new Set(members.map((member) => member.modelId)).size !== members.length) throw new Error(`Combo "${combo.combo}" references the same target through multiple aliases. Remove duplicate targets before migrating.`)
        writes.push({ path: row.path, collection: row.collection_path, id: row.document_id, data: { ...combo, members } })
      }
    }
    const backup = `${file}.before-aliases-to-combos`
    if (apply && deletes.length) {
      if (existsSync(backup)) throw new Error(`Backup already exists: ${backup}`)
      db.run("VACUUM INTO ?", [backup])
      chmodSync(backup, 0o600)
      db.transaction(() => {
        const put = db.query("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP")
        for (const write of writes) put.run(write.path, write.collection, write.id, JSON.stringify(write.data))
        const remove = db.query("DELETE FROM rawroute_documents WHERE path = ?")
        for (const path of deletes) remove.run(path)
      })()
    }
    return { aliases: deletes.length, workspaces: roots.size, applied: apply && deletes.length > 0, ...(apply && deletes.length ? { backup } : {}) }
  } finally { db.close() }
}

if (import.meta.main) {
  const file = process.env.SQLITE_PATH || join(process.env.RAWROUTE_DATA_DIR || "data", "rawroute.sqlite")
  console.log(JSON.stringify(migrateAliasesToCombos(file, process.argv.includes("--apply")), null, 2))
}
