import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { parse as parseYaml } from "yaml"
import {
  codexCredentialSchemaVersion,
  createCodexCredentialSchema,
} from "@rawroute/gateway-ai/server/maintenance/codex-credentials"
import {
  codexResetSchemaVersion,
} from "@rawroute/gateway-ai/server/maintenance/codex-reset"
import { collectionPrefix } from "@rawroute/platform/server/storage-config"

import {
  applyCodexResetIdentityPlan,
  codexResetAccountKey,
  codexDocumentFingerprint,
  planCodexResetIdentity,
} from "./codex-reset-identity"

type DocumentRow = { path: string; collection_path: string; document_id: string; data: string; updated_at: string }
type AuthFile = {
  accessToken: string
  refreshToken?: string
  idToken?: string
  accountId: string
  email?: string
  planType?: string
  expiresAt?: string
  lastRefresh?: string
  disabled: boolean
  priority: number
}
type AccountPlan = {
  workspaceId: string
  providerId: string
  row: DocumentRow
  data: Record<string, unknown>
  imported: AuthFile
  mapping: string
  authPath: string
  authBytes: Buffer
}
type SourceAuth = { mapping: string; path: string; bytes: Buffer; imported: AuthFile }
type MigrationPlan = {
  prefix: string
  credentialVersion: number | null | undefined
  planned: AccountPlan[]
  overrides: Map<string, string>
  resetPlan: ReturnType<typeof planCodexResetIdentity>
  required: boolean
  documentFingerprint: string
  configBytes?: Buffer
  sourceInventory: SourceAuth[]
}

type MigrationOptions = {
  apply?: boolean
  writersStopped?: boolean
  authDir: string
  config: string
  backupDir?: string
}

const legacyKind = "codex-cli-proxy"
const currentKind = "codex-oauth"
const legacyFields = ["cliProxyAuthFile", "cliProxyAuthIndex", "cliProxyStatus", "cliProxyStatusMessage"]

function configMapping(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Legacy config must contain a mapping.")
  return value as Record<string, unknown>
}

function parseConfig(contents: string) {
  return configMapping(parseYaml(contents, { uniqueKeys: true, merge: true, maxAliasCount: 100 }))
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function rowObject(row: DocumentRow) {
  let value: unknown
  try { value = JSON.parse(row.data) as unknown } catch { throw new Error("Invalid Codex migration document JSON.") }
  const data = objectValue(value)
  if (!data) throw new Error("Invalid Codex migration document.")
  return data
}

function likePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&")
}

function applicationRows(database: Database, prefix: string) {
  const root = `${likePattern(prefix)}\\_workspaces/`
  return database.query<DocumentRow, [string, string]>(`
    SELECT path, collection_path, document_id, data, updated_at FROM rawroute_documents
    WHERE collection_path LIKE ? ESCAPE '\\'
       OR collection_path LIKE ? ESCAPE '\\'
    ORDER BY path
  `).all(`${root}%/providers`, `${root}%/providers/%/apiKeys`)
}

function stringField(data: Record<string, unknown>, key: string, label: string) {
  if (!Object.hasOwn(data, key) || data[key] === undefined || data[key] === null || data[key] === "") return undefined
  if (typeof data[key] !== "string" || !data[key].trim()) throw new Error(`Invalid ${label} in mapped Codex auth file.`)
  return data[key] as string
}

function jwtAccountId(idToken: string | undefined) {
  if (!idToken) return undefined
  const parts = idToken.split(".")
  if (parts.length !== 3 || !parts[1]) throw new Error("Mapped Codex auth file has an invalid ID token.")
  let payload: Record<string, unknown> | undefined
  try { payload = objectValue(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown) } catch {
    throw new Error("Mapped Codex auth file has an invalid ID token.")
  }
  if (!payload) throw new Error("Mapped Codex auth file has an invalid ID token.")
  const authClaims = objectValue(payload["https://api.openai.com/auth"])
  const accountId = stringField(payload, "chatgpt_account_id", "Codex account identity")
    || stringField(payload, "account_id", "Codex account identity")
    || (authClaims ? stringField(authClaims, "chatgpt_account_id", "Codex account identity") : undefined)
  return accountId
}

function filePriority(value: unknown) {
  if (value === undefined || value === null) return 0
  const priority = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) throw new Error("Mapped Codex auth file has an invalid priority.")
  return priority
}
function parseAuthFile(bytes: Buffer): AuthFile {
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString("utf8")) as unknown } catch { throw new Error("Mapped Codex auth file is not valid JSON.") }
  const data = objectValue(parsed)
  if (!data || typeof data.type !== "string" || data.type.toLowerCase() !== "codex") throw new Error("Mapped auth file is not a supported Codex OAuth record.")
  const accessToken = stringField(data, "access_token", "access token")
  if (!accessToken) throw new Error("Mapped Codex auth file is missing its access token.")
  const refreshToken = stringField(data, "refresh_token", "refresh token")
  const idToken = stringField(data, "id_token", "ID token")
  const tokenAccountId = jwtAccountId(idToken)
  const directAccountId = stringField(data, "account_id", "Codex account identity")
  if (directAccountId && tokenAccountId && directAccountId !== tokenAccountId) throw new Error("Codex auth-file identity does not match its ID token.")
  const accountId = directAccountId || tokenAccountId
  if (!accountId) throw new Error("Mapped Codex auth file has no account identity.")
  if (data.disabled !== undefined && typeof data.disabled !== "boolean") throw new Error("Mapped Codex auth file has an invalid disabled state.")
  if (data.use_siwc !== undefined && typeof data.use_siwc !== "boolean") throw new Error("Mapped Codex auth file has an invalid active-session selector.")
  if (data.use_siwc === true) throw new Error("Mapped Codex auth file uses an active SIWC session that cannot be represented by this migration.")
  const priority = filePriority(data.priority)
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    accountId,
    ...(stringField(data, "email", "email") ? { email: stringField(data, "email", "email") } : {}),
    ...(stringField(data, "plan_type", "plan type") ? { planType: stringField(data, "plan_type", "plan type") } : {}),
    ...(stringField(data, "expired", "expiry") || stringField(data, "expires_at", "expiry")
      ? { expiresAt: stringField(data, "expired", "expiry") || stringField(data, "expires_at", "expiry") }
      : {}),
    ...(stringField(data, "last_refresh", "refresh timestamp") ? { lastRefresh: stringField(data, "last_refresh", "refresh timestamp") } : {}),
    disabled: data.disabled ?? false,
    priority,
  }
}

function configuredAuthDirectory(configBytes: Buffer) {
  let config: Record<string, unknown>
  try { config = parseConfig(configBytes.toString("utf8")) } catch { throw new Error("CLIProxy config snapshot is not a supported YAML or JSON mapping.") }
  if (config["config-version"] !== 8 || Object.hasOwn(config, "auth-dir")) throw new Error("CLIProxy config must use the v8 oauth.auth-dir layout.")
  const oauth = config.oauth === undefined ? {} : configMapping(config.oauth)
  let configured = oauth["auth-dir"]
  if (configured === undefined || configured === "") configured = "~/.cli-proxy-api"
  if (typeof configured !== "string" || !configured.trim()) throw new Error("CLIProxy config has no valid auth directory.")
  const path = configured.trim()
  if (path === "~") configured = homedir()
  else if (path.startsWith("~/") || path.startsWith("~\\")) configured = resolve(homedir(), path.slice(2).replaceAll("\\", sep))
  else if (path.startsWith("~")) throw new Error("CLIProxy config uses an unsupported home-directory auth path.")
  else if (!isAbsolute(path)) throw new Error("CLIProxy config auth-dir must be absolute; its original working directory cannot be inferred safely.")
  else configured = path
  return resolve(configured as string)
}

function inventoryAuthFiles(authDir: string, configPath: string) {
  assertPrivateSourceDirectory(authDir)
  const configBytes = stableSourceBytes(configPath, "The CLIProxy config snapshot")
  const configured = configuredAuthDirectory(configBytes)
  if (configured !== resolve(authDir)) throw new Error("The supplied auth directory does not match CLIProxy config oauth.auth-dir.")
  const inventory: SourceAuth[] = []
  const visit = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) throw new Error("CLIProxy auth directory contains a symbolic link.")
      if (info.isDirectory()) {
        visit(path)
        continue
      }
      if (!info.isFile() || !/\.json$/i.test(entry.name)) continue
      const bytes = stableSourceBytes(path, "A CLIProxy auth file")
      let value: unknown
      try { value = JSON.parse(bytes.toString("utf8")) as unknown } catch { throw new Error("CLIProxy auth directory contains an invalid JSON file.") }
      const data = objectValue(value)
      if (!data) throw new Error("CLIProxy auth directory contains a non-object JSON file.")
      if (typeof data.type === "string" && data.type.trim().toLowerCase() === "codex") {
        const imported = parseAuthFile(bytes)
        const mapping = relative(authDir, path).split(sep).join("/")
        inventory.push({ mapping, path, bytes, imported })
      } else if (data.type === undefined && ["access_token", "refresh_token", "id_token"].some(field => Object.hasOwn(data, field))) {
        throw new Error("CLIProxy auth file has OAuth tokens but no provider type.")
      }
    }
  }
  visit(authDir)
  return { configBytes, inventory }
}

function providerAccounts(database: Database, prefix: string) {
  const rows = applicationRows(database, prefix)
  const providerRows = rows.filter(row => {
    const parts = row.collection_path.split("/")
    return parts.length === 3 && parts[0] === `${prefix}_workspaces` && parts[2] === "providers"
  })
  const codexProviders = new Map<string, string>()
  const providerIds = new Map<string, string>()
  for (const row of providerRows) {
    if (row.path !== `${row.collection_path}/${row.document_id}`) throw new Error("Invalid provider document path in Codex migration.")
    const parts = row.collection_path.split("/")
    const workspaceId = parts[1]
    if (!workspaceId) throw new Error("Invalid workspace path in Codex migration.")
    const provider = rowObject(row)
    if (provider.prefix !== "codex") continue
    const workspaceKey = `${workspaceId}\0codex`
    if (codexProviders.has(workspaceKey)) throw new Error("Multiple Codex providers exist in one workspace.")
    codexProviders.set(workspaceKey, row.document_id)
    providerIds.set(`${workspaceId}\0${row.document_id}`, workspaceKey)
  }

  const accountRows = rows.filter(row => row.collection_path.endsWith("/apiKeys"))
  const accounts: Array<{ workspaceId: string; providerId: string; row: DocumentRow; data: Record<string, unknown> }> = []
  for (const row of accountRows) {
    const parts = row.collection_path.split("/")
    if (parts.length !== 5 || parts[0] !== `${prefix}_workspaces` || parts[2] !== "providers") continue
    const workspaceId = parts[1]!
    const providerId = parts[3]!
    const isCodexProvider = providerIds.has(`${workspaceId}\0${providerId}`)
    if (row.path !== `${row.collection_path}/${row.document_id}`) throw new Error("Invalid provider account document path in Codex migration.")
    const data = rowObject(row)
    const hasLegacyFields = legacyFields.some(field => Object.hasOwn(data, field))
    if ((data.credentialKind === legacyKind || hasLegacyFields) && !isCodexProvider) throw new Error("A legacy Codex account is attached to a non-Codex provider.")
    if (isCodexProvider && data.credentialKind === currentKind) {
      if (legacyFields.some(field => Object.hasOwn(data, field))) throw new Error("A converted Codex account still contains legacy auth-file mappings.")
      continue
    }
    if (isCodexProvider && (data.credentialKind === legacyKind || hasLegacyFields)) {
      if (data.credentialKind !== legacyKind) throw new Error("A legacy Codex auth-file mapping has an unknown credential kind.")
      accounts.push({ workspaceId, providerId, row, data })
    }
  }
  return { accounts, providerRows }
}

function validateSourceFile(path: string, label: string) {
  let info
  try { info = lstatSync(path) } catch { throw new Error(`${label} is missing.`) }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file.`)
  return readFileSync(path)
}

function stableSourceBytes(path: string, label: string) {
  const first = validateSourceFile(path, label)
  const second = validateSourceFile(path, label)
  if (!first.equals(second)) throw new Error(`${label} changed while it was being backed up.`)
  return first
}

function assertPrivateSourceDirectory(path: string) {
  let info
  try { info = lstatSync(path) } catch { throw new Error("The CLIProxy auth directory is missing.") }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("The CLIProxy auth directory must be a regular directory.")
}

function planAccounts(accounts: ReturnType<typeof providerAccounts>["accounts"], inventory: SourceAuth[]) {
  const filesByMapping = new Map(inventory.map(file => [file.mapping, file]))
  const usedMappings = new Set<string>()
  const overrides = new Map<string, string>()
  const planned: AccountPlan[] = accounts.map(({ workspaceId, providerId, row, data }) => {
    if (typeof data.cliProxyAuthFile !== "string" || !data.cliProxyAuthFile) throw new Error("A Codex account has no exact auth-file mapping.")
    const mapping = data.cliProxyAuthFile
    const source = filesByMapping.get(mapping)
    if (!source) throw new Error("A mapped Codex auth file is missing from the configured source inventory.")
    const imported = source.imported
    if (typeof data.enabled !== "boolean") throw new Error("A Codex account has no authoritative enabled state.")
    if (data.enabled === imported.disabled) throw new Error("Codex account enabled state does not match its mapped auth file.")
    const storedAccountId = typeof data.accountId === "string" && data.accountId.trim() ? data.accountId : undefined
    if (storedAccountId && storedAccountId !== imported.accountId) throw new Error("Codex account identity does not match its mapped auth file.")
    const storedPriority = data.priority
    if (storedPriority !== undefined && (!Number.isSafeInteger(storedPriority) || (storedPriority as number) < 0 || (storedPriority as number) > 100)) {
      throw new Error("A Codex account has an invalid authoritative priority.")
    }
    if (storedPriority !== undefined && storedPriority !== imported.priority) {
      throw new Error("Codex account priority does not match its mapped auth file.")
    }
    const priority = storedPriority === undefined ? imported.priority : storedPriority as number
    if (usedMappings.has(mapping)) throw new Error("A CLIProxy auth file is mapped to multiple Codex accounts.")
    usedMappings.add(mapping)
    if (typeof data.key !== "string" || data.key !== "") throw new Error("A legacy Codex account contains unexpected public credential data.")
    if (["accessToken", "refreshToken", "idToken", "access_token", "refresh_token", "id_token"].some(field => Object.hasOwn(data, field))) {
      throw new Error("A legacy Codex account contains unexpected token data in its public record.")
    }
    if (typeof data.name !== "string" || !data.name.trim()) throw new Error("A legacy Codex account has no saved name.")
    const identityKey = codexResetAccountKey(workspaceId, row.document_id)
    if (overrides.has(identityKey)) throw new Error("Multiple Codex accounts share a local credential ID.")
    overrides.set(identityKey, imported.accountId)
    return { workspaceId, providerId, row, data, imported: { ...imported, priority }, mapping, authPath: source.path, authBytes: source.bytes }
  })
  if (usedMappings.size !== inventory.length || inventory.some(file => !usedMappings.has(file.mapping))) {
    throw new Error("CLIProxy auth directory contains a Codex account with no exact RawRoute mapping.")
  }
  return { planned, overrides }
}

function accountDocument(plan: AccountPlan) {
  const next: Record<string, unknown> = {
    ...plan.data,
    key: "",
    credentialKind: currentKind,
    accountId: plan.imported.accountId,
    email: plan.imported.email ?? plan.data.email,
    planType: plan.imported.planType ?? plan.data.planType,
    expiresAt: plan.imported.expiresAt,
    lastRefresh: plan.imported.lastRefresh,
    enabled: plan.data.enabled,
    priority: plan.imported.priority,
  }
  for (const field of legacyFields) delete next[field]
  for (const field of ["email", "planType", "expiresAt", "lastRefresh"]) if (next[field] === undefined) delete next[field]
  return next
}

function syncPath(path: string) {
  const descriptor = openSync(path, "r")
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function withPrivateUmask<T>(operation: () => T): T {
  const previous = process.umask(0o077)
  try { return operation() } finally { process.umask(previous) }
}

function privateDirectory(path: string) {
  if (existsSync(path)) throw new Error("Refusing to overwrite an existing backup directory.")
  mkdirSync(path, { recursive: false, mode: 0o700 })
  chmodSync(path, 0o700)
  syncPath(path)
  syncPath(dirname(path))
}

function privateCopy(target: string, bytes: Buffer, backupDir: string) {
  let directory = resolve(backupDir)
  for (const segment of relative(directory, dirname(target)).split(sep).filter(Boolean)) {
    const parent = directory
    directory = resolve(directory, segment)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    syncPath(directory)
    syncPath(parent)
  }
  writeFileSync(target, bytes, { flag: "wx", mode: 0o600 })
  chmodSync(target, 0o600)
  syncPath(target)
  syncPath(dirname(target))
  const copied = readFileSync(target)
  if (!copied.equals(bytes)) throw new Error("A private backup file failed validation.")
  const info = lstatSync(target)
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error("A backup file is not private.")
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex")
}

function createBackup(database: Database, file: string, backupDir: string, configPath: string, authDir: string, plan: MigrationPlan) {
  if (resolve(backupDir) === resolve(file) || (configPath && resolve(backupDir) === resolve(configPath))) throw new Error("Backup directory must not overwrite a source path.")
  if (authDir) {
    const relativePath = relative(resolve(authDir), resolve(backupDir))
    if (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath)) throw new Error("Backup directory must be outside the CLIProxy auth directory.")
  }
  const configBytes = plan.configBytes
  if (configBytes && (!configPath || !stableSourceBytes(configPath, "The CLIProxy config snapshot").equals(configBytes))) {
    throw new Error("The CLIProxy config changed after migration planning.")
  }
  privateDirectory(backupDir)
  const databaseBackup = resolve(backupDir, "rawroute.sqlite")
  withPrivateUmask(() => database.run("VACUUM INTO ?", [databaseBackup]))
  chmodSync(databaseBackup, 0o600)
  syncPath(databaseBackup)
  syncPath(backupDir)
  const backupDb = new Database(databaseBackup, { readonly: true })
  try {
    if (backupDb.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("SQLite backup integrity check failed.")
    if (codexDocumentFingerprint(backupDb) !== plan.documentFingerprint) throw new Error("SQLite backup validation did not match the source database.")
  } finally { backupDb.close() }

  if (configBytes) privateCopy(resolve(backupDir, "cliproxy-config.snapshot"), configBytes, backupDir)
  for (const account of plan.planned) {
    privateCopy(resolve(backupDir, "auth", ...account.mapping.split("/")), account.authBytes, backupDir)
    if (!stableSourceBytes(account.authPath, "A mapped Codex auth file").equals(account.authBytes)) throw new Error("A mapped Codex auth file changed while it was being backed up.")
  }
  if (configBytes && !stableSourceBytes(configPath, "The CLIProxy config snapshot").equals(configBytes)) throw new Error("The CLIProxy config changed while it was being backed up.")
  const manifest = {
    version: 1,
    sourceDatabase: resolve(file),
    ...(configPath ? { sourceConfig: resolve(configPath) } : {}),
    sourceAuthDir: authDir ? resolve(authDir) : "",
    mappedAuthFiles: plan.planned.map(account => ({ path: account.mapping, sha256: sha256(account.authBytes) })),
  }
  privateCopy(resolve(backupDir, "manifest.json"), Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), backupDir)
  syncPath(backupDir)
  return backupDir
}

function schemaVersion(value: number | null | undefined, label: string) {
  if (value !== undefined && value !== 1) throw new Error(`Unsupported ${label} schema version: ${value}`)
}

function buildMigrationPlan(database: Database, authDir: string, configPath: string): MigrationPlan {
  if (!database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rawroute_documents'").get()) throw new Error("RawRoute document table is missing.")
  const credentialVersion = codexCredentialSchemaVersion(database)
  schemaVersion(credentialVersion, "Codex credential")
  const prefix = collectionPrefix(database)
  const { accounts } = providerAccounts(database, prefix)
  if (credentialVersion === 1 && accounts.length) throw new Error("Codex credential schema is marked current but legacy auth-file mappings remain.")
  const currentCredentials = applicationRows(database, prefix).some(row => {
    if (!row.collection_path.endsWith("/apiKeys")) return false
    return rowObject(row).credentialKind === currentKind
  })
  if (credentialVersion === undefined && currentCredentials) throw new Error("Codex OAuth accounts exist without their schema marker; inspect the database before migrating.")

  let configBytes: Buffer | undefined
  let sourceInventory: SourceAuth[] = []
  if (credentialVersion !== 1) {
    if (!authDir) throw new Error("An explicit --auth-dir is required before Codex credentials can be migrated.")
    if (!configPath) throw new Error("An explicit --config snapshot path is required before Codex credentials can be migrated.")
    const source = inventoryAuthFiles(authDir, configPath)
    configBytes = source.configBytes
    sourceInventory = source.inventory
  } else if (configPath && existsSync(configPath)) {
    configBytes = stableSourceBytes(configPath, "The CLIProxy config snapshot")
  }
  const { planned, overrides } = planAccounts(accounts, sourceInventory)
  const resetPlan = planCodexResetIdentity(database, overrides)
  schemaVersion(codexResetSchemaVersion(database), "Codex reset")
  for (const plan of planned) {
    const collection = `${prefix}_workspaces/${plan.workspaceId}/codexCredentials`
    if (database.query("SELECT 1 FROM rawroute_documents WHERE path = ?").get(`${collection}/${plan.row.document_id}`)) {
      throw new Error("A Codex credential secret already exists for a legacy account.")
    }
  }
  return {
    prefix,
    credentialVersion,
    planned,
    overrides,
    resetPlan,
    required: credentialVersion !== 1 || planned.length > 0 || !resetPlan.schemaReady || resetPlan.rewrites.length > 0,
    documentFingerprint: resetPlan.documentFingerprint,
    configBytes,
    sourceInventory,
  }
}

function migrationPlanSignature(plan: MigrationPlan) {
  return JSON.stringify({
    prefix: plan.prefix,
    credentialVersion: plan.credentialVersion,
    documentFingerprint: plan.documentFingerprint,
    accounts: plan.planned.map(account => [account.row.path, account.row.data, account.mapping, sha256(account.authBytes), accountDocument(account)]),
    sourceInventory: plan.sourceInventory.map(file => [file.mapping, sha256(file.bytes)]),
    config: plan.configBytes ? sha256(plan.configBytes) : undefined,
    resetSchemaReady: plan.resetPlan.schemaReady,
    resetRecords: plan.resetPlan.rewrites.map(rewrite => [rewrite.source.path, rewrite.source.data, rewrite.source.updated_at, rewrite.targetPath]),
  })
}

function applyMigrationPlan(database: Database, plan: MigrationPlan) {
  const updateAccount = database.query("UPDATE rawroute_documents SET data = ? WHERE path = ?")
  const insertSecret = database.query("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?)")
  for (const account of plan.planned) {
    const credentialId = account.row.document_id
    const collection = `${plan.prefix}_workspaces/${account.workspaceId}/codexCredentials`
    const path = `${collection}/${credentialId}`
    const data = {
      accessToken: account.imported.accessToken,
      ...(account.imported.refreshToken ? { refreshToken: account.imported.refreshToken } : {}),
      ...(account.imported.idToken ? { idToken: account.imported.idToken } : {}),
      ...(account.imported.expiresAt ? { expiresAt: account.imported.expiresAt } : {}),
      ...(account.imported.lastRefresh ? { lastRefresh: account.imported.lastRefresh } : {}),
      accountId: account.imported.accountId,
      version: 1,
    }
    insertSecret.run(path, collection, credentialId, JSON.stringify(data))
    updateAccount.run(JSON.stringify(accountDocument(account)), account.row.path)
  }
  applyCodexResetIdentityPlan(database, plan.resetPlan)
  createCodexCredentialSchema(database)
}

/** Import the mapped CLIProxy Codex OAuth files into workspace-owned SQLite sessions. */
export function migrateCodexCredentials(file: string, options: MigrationOptions) {
  if (!file || !existsSync(file)) throw new Error("An explicit existing --sqlite path is required.")
  if (options.apply && !options.writersStopped) throw new Error("Stop RawRoute, CLIProxy, and every SQLite writer; pass --writers-stopped before --apply.")
  const databaseInfo = lstatSync(file)
  if (databaseInfo.isSymbolicLink() || !databaseInfo.isFile()) throw new Error("The SQLite source must be a regular file.")
  const database = new Database(file, options.apply ? { readwrite: true } : { readonly: true })
  let transactionOpen = false
  try {
    const authDir = options.authDir ? resolve(options.authDir) : ""
    const configPath = options.config ? resolve(options.config) : ""
    if (options.apply) {
      database.run("PRAGMA busy_timeout = 0")
      database.run("PRAGMA locking_mode = EXCLUSIVE")
      database.run("BEGIN EXCLUSIVE")
      transactionOpen = true
    }
    const plan = buildMigrationPlan(database, authDir, configPath)
    if (!plan.required) {
      if (transactionOpen) { database.run("COMMIT"); transactionOpen = false }
      return { applied: false, required: false, accounts: 0, resetRecords: 0 }
    }
    if (!options.apply) return { applied: false, required: true, accounts: plan.planned.length, resetRecords: plan.resetPlan.rewrites.length }

    database.run("COMMIT")
    transactionOpen = false
    const backupDir = resolve(options.backupDir || `${resolve(file)}.before-codex-credentials`)
    const backup = createBackup(database, file, backupDir, configPath, authDir, plan)
    database.run("BEGIN EXCLUSIVE")
    transactionOpen = true
    const currentPlan = buildMigrationPlan(database, authDir, configPath)
    if (migrationPlanSignature(currentPlan) !== migrationPlanSignature(plan)) throw new Error("Codex migration inputs changed while the backup was created; no data was modified.")
    applyMigrationPlan(database, currentPlan)
    database.run("COMMIT")
    transactionOpen = false
    return { applied: true, required: false, accounts: plan.planned.length, resetRecords: plan.resetPlan.rewrites.length, backup }
  } catch (error) {
    if (transactionOpen && database.inTransaction) database.run("ROLLBACK")
    throw error
  } finally { database.close() }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    return index < 0 ? undefined : args[index + 1]
  }
  const options = ["--sqlite", "--auth-dir", "--config", "--backup-dir"]
  for (const flag of options) if (args.includes(flag) && (!value(flag) || value(flag)!.startsWith("--"))) throw new Error(`${flag} requires a path.`)
  const allowed = new Set([...options, "--apply", "--writers-stopped"])
  for (const arg of args) if (arg.startsWith("--") && !allowed.has(arg)) throw new Error(`Unknown option: ${arg}`)
  if (!args.includes("--sqlite") || !value("--sqlite")) throw new Error("Required: --sqlite <database>; legacy Codex data also requires --auth-dir <old auth directory> and --config <old config snapshot>. Preview is the default; apply requires --apply --writers-stopped; optional --backup-dir <new private directory>.")
  if (args.includes("--auth-dir") !== args.includes("--config")) throw new Error("Provide both --auth-dir and --config for legacy Codex data.")
  console.log(JSON.stringify(migrateCodexCredentials(value("--sqlite")!, {
    authDir: value("--auth-dir") || "",
    config: value("--config") || "",
    apply: args.includes("--apply"),
    writersStopped: args.includes("--writers-stopped"),
    backupDir: value("--backup-dir"),
  }), null, 2))
}
