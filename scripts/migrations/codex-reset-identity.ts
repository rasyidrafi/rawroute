import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmodSync, closeSync, existsSync, fsyncSync, openSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { hasCodexCredentialSchema } from "@rawroute/gateway-ai/server/maintenance/codex-credentials"
import { codexResetSchemaVersion, createCodexResetSchema } from "@rawroute/gateway-ai/server/maintenance/codex-reset"
import { collectionPrefix } from "@rawroute/platform/server/storage-config"

type DocumentRow = { path: string; collection_path: string; document_id: string; data: string; updated_at: string }
type Rewrite = { source: DocumentRow; targetPath: string; targetId: string }
export type CodexResetIdentityPlan = { rewrites: Rewrite[]; schemaReady: boolean; documentFingerprint: string }

export function codexResetAccountKey(workspaceId: string, credentialId: string) {
  return `${workspaceId}\0${credentialId}`
}

function identityDocumentId(accountId: string) {
  return `account-${createHash("sha256").update(accountId).digest("hex")}`
}

function recordObject(row: DocumentRow) {
  const value = JSON.parse(row.data) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex migration document.")
  return value as Record<string, unknown>
}

export function codexDocumentFingerprint(database: Database) {
  const hash = createHash("sha256")
  const rows = database.query<{ path: string; collection_path: string; document_id: string; data: string; updated_at: string }, []>(
    "SELECT path, collection_path, document_id, data, updated_at FROM rawroute_documents ORDER BY path",
  )
  for (const row of rows.iterate()) {
    for (const value of [row.path, row.collection_path, row.document_id, row.data, row.updated_at]) {
      const size = Buffer.byteLength(value)
      hash.update(`${size}:`).update(value).update(";")
    }
  }
  return hash.digest("hex")
}

function likePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&")
}

function relevantDocuments(database: Database, prefix: string) {
  const root = `${likePattern(prefix)}\\_workspaces/`
  return database.query<DocumentRow, [string, string, string]>(`
    SELECT path, collection_path, document_id, data, updated_at FROM rawroute_documents
    WHERE collection_path LIKE ? ESCAPE '\\'
       OR collection_path LIKE ? ESCAPE '\\'
       OR collection_path LIKE ? ESCAPE '\\'
    ORDER BY path
  `).all(`${root}%/providers`, `${root}%/providers/%/apiKeys`, `${root}%/codexResetAutomationAccounts`)
}

function accountIdentityMap(rows: DocumentRow[], prefix: string, overrides: ReadonlyMap<string, string>) {
  const providerPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_workspaces/([^/]+)/providers$`)
  const providers = new Map<string, string>()
  for (const row of rows) {
    if (!providerPattern.test(row.collection_path)) continue
    if (row.path !== `${row.collection_path}/${row.document_id}`) throw new Error("Invalid Codex provider document path.")
    if (recordObject(row).prefix !== "codex") continue
    const workspaceId = providerPattern.exec(row.collection_path)![1]!
    const key = `${workspaceId}\0${row.document_id}`
    if (providers.has(key)) throw new Error("Multiple Codex providers exist in one workspace.")
    providers.set(key, `${row.collection_path}/${row.document_id}/apiKeys`)
  }

  const accountIds = new Map<string, string>()
  for (const row of rows) {
    const workspacePrefix = `${prefix}_workspaces/`
    if (!row.collection_path.startsWith(workspacePrefix) || !row.collection_path.endsWith("/apiKeys")) continue
    const parts = row.collection_path.slice(workspacePrefix.length).split("/")
    if (parts.length !== 4 || parts[1] !== "providers") continue
    const workspaceId = parts[0]!
    const providerId = parts[2]!
    if (providers.get(`${workspaceId}\0${providerId}`) !== row.collection_path) continue
    if (row.path !== `${row.collection_path}/${row.document_id}`) throw new Error("Invalid Codex account document path.")
    const account = recordObject(row)
    if (account.credentialKind !== "codex-oauth" && account.credentialKind !== "codex-cli-proxy") continue
    const key = codexResetAccountKey(workspaceId, row.document_id)
    const override = overrides.get(key)
    const storedId = typeof account.accountId === "string" && account.accountId.trim() ? account.accountId : undefined
    if (override && storedId && override !== storedId) throw new Error("Codex account identity changed during migration planning.")
    const accountId = override || storedId
    if (!accountId) continue
    if (accountIds.has(key)) throw new Error("Multiple Codex accounts share a local credential ID.")
    accountIds.set(key, accountId)
  }
  return accountIds
}

/** Plan safety-record moves without modifying the database. `overrides` supplies identities read from mapped auth files. */
export function planCodexResetIdentity(database: Database, overrides: ReadonlyMap<string, string> = new Map()): CodexResetIdentityPlan {
  const prefix = collectionPrefix(database)
  const rows = relevantDocuments(database, prefix)
  const accountIds = accountIdentityMap(rows, prefix, overrides)
  const resetPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_workspaces/([^/]+)/codexResetAutomationAccounts$`)
  const byPath = new Map(rows.map(row => [row.path, row]))
  const rewrites: Rewrite[] = []
  const targets = new Set<string>()
  for (const source of rows) {
    const match = resetPattern.exec(source.collection_path)
    if (!match || /^account-[a-f0-9]{64}$/.test(source.document_id)) continue
    if (source.path !== `${source.collection_path}/${source.document_id}`) throw new Error("Invalid Codex reset document path.")
    const workspaceId = match[1]!
    const accountId = accountIds.get(codexResetAccountKey(workspaceId, source.document_id))
    if (!accountId) throw new Error("A Codex reset safety record has no connected account identity.")
    const targetId = identityDocumentId(accountId)
    const targetPath = `${source.collection_path}/${targetId}`
    if (byPath.has(targetPath)) throw new Error("Codex reset identity collision; inspect the database before migrating.")
    if (targets.has(targetPath)) throw new Error("Multiple reset records map to one Codex account.")
    targets.add(targetPath)
    rewrites.push({ source, targetPath, targetId })
  }

  const version = codexResetSchemaVersion(database)
  if (version !== undefined && version !== 1) throw new Error(`Unsupported Codex reset schema version: ${version}`)
  const schemaReady = version === 1
  if (schemaReady && rewrites.length) throw new Error("Current Codex reset schema contains local-ID records; inspect the database before migrating.")
  return { rewrites, schemaReady, documentFingerprint: codexDocumentFingerprint(database) }
}

/** Apply a previously validated reset plan within the caller's transaction. */
export function applyCodexResetIdentityPlan(database: Database, plan: CodexResetIdentityPlan) {
  const insert = database.query("INSERT INTO rawroute_documents (path, collection_path, document_id, data, updated_at) VALUES (?, ?, ?, ?, ?)")
  const remove = database.query("DELETE FROM rawroute_documents WHERE path = ?")
  for (const rewrite of plan.rewrites) {
    insert.run(rewrite.targetPath, rewrite.source.collection_path, rewrite.targetId, rewrite.source.data, rewrite.source.updated_at)
    remove.run(rewrite.source.path)
  }
  createCodexResetSchema(database)
}

function syncPath(path: string) {
  const descriptor = openSync(path, "r")
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function resetPlanSignature(plan: CodexResetIdentityPlan) {
  return JSON.stringify({
    schemaReady: plan.schemaReady,
    documentFingerprint: plan.documentFingerprint,
    rewrites: plan.rewrites.map(({ source, targetPath, targetId }) => [source.path, source.data, source.updated_at, targetPath, targetId]),
  })
}

function vacuumBackup(database: Database, backup: string) {
  const previousUmask = process.umask(0o077)
  try { database.run("VACUUM INTO ?", [backup]) } finally { process.umask(previousUmask) }
  chmodSync(backup, 0o600)
  syncPath(backup)
  syncPath(dirname(backup))
}

/** Move reset safety records from removable local IDs to workspace-scoped account identities. */
export function migrateCodexResetIdentity(file: string, options: { apply?: boolean; writersStopped?: boolean; backup?: string } = {}) {
  if (!file || !existsSync(file)) throw new Error("An explicit existing --sqlite path is required")
  if (options.apply && !options.writersStopped) throw new Error("Stop RawRoute and all SQLite writers; pass --writers-stopped before --apply")
  const database = new Database(file, options.apply ? { readwrite: true } : { readonly: true })
  let transactionOpen = false
  try {
    if (options.apply) {
      database.run("PRAGMA busy_timeout = 0")
      database.run("PRAGMA locking_mode = EXCLUSIVE")
      database.run("BEGIN EXCLUSIVE")
      transactionOpen = true
    }
    if (!database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rawroute_documents'").get()) throw new Error("RawRoute document table is missing")
    if (!hasCodexCredentialSchema(database)) throw new Error("Run scripts/migrations/codex-credentials.ts before the Codex reset identity migration.")
    const plan = planCodexResetIdentity(database)
    const required = !plan.schemaReady || plan.rewrites.length > 0
    if (!required) {
      if (transactionOpen) { database.run("COMMIT"); transactionOpen = false }
      return { applied: false, required, records: 0 }
    }
    if (!options.apply) return { applied: false, required, records: plan.rewrites.length }
    database.run("COMMIT")
    transactionOpen = false
    const backup = resolve(options.backup || `${file}.before-codex-reset-identity`)
    if (backup === resolve(file) || existsSync(backup)) throw new Error("Refusing to overwrite source or backup")
    vacuumBackup(database, backup)
    const backupDb = new Database(backup, { readonly: true })
    try {
      if (backupDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Backup integrity check failed")
      if (codexDocumentFingerprint(backupDb) !== plan.documentFingerprint) throw new Error("Backup does not match the stopped source database")
    } finally { backupDb.close() }
    database.run("BEGIN EXCLUSIVE")
    transactionOpen = true
    const currentPlan = planCodexResetIdentity(database)
    if (resetPlanSignature(currentPlan) !== resetPlanSignature(plan)) throw new Error("Codex reset records changed while the backup was created; no data was modified.")
    applyCodexResetIdentityPlan(database, currentPlan)
    database.run("COMMIT")
    transactionOpen = false
    return { applied: true, required: false, records: plan.rewrites.length, backup }
  } catch (error) {
    if (transactionOpen && database.inTransaction) database.run("ROLLBACK")
    throw error
  } finally { database.close() }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  const file = value("--sqlite")
  if (!args.includes("--sqlite") || !file || file.startsWith("--")) throw new Error("Required: --sqlite <stopped database>; optional --apply --writers-stopped --backup <new file>")
  if (args.includes("--backup") && (!value("--backup") || value("--backup")!.startsWith("--"))) throw new Error("--backup requires a new file path")
  console.log(JSON.stringify(migrateCodexResetIdentity(file, {
    apply: args.includes("--apply"),
    writersStopped: args.includes("--writers-stopped"),
    backup: args.includes("--backup") ? value("--backup") : undefined,
  }), null, 2))
}
