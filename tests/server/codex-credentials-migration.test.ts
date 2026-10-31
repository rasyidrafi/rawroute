import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { codexCredentialSchemaVersion } from "@rawroute/gateway-ai/server/maintenance/codex-credentials"
import { codexResetSchemaVersion } from "@rawroute/gateway-ai/server/maintenance/codex-reset"
import { migrateCodexCredentials } from "../../scripts/migrations/codex-credentials"
import { migrateCodexResetIdentity } from "../../scripts/migrations/codex-reset-identity"

const directories: string[] = []
const prefix = "rawroute"
const workspaceId = "migration-workspace"
const providerId = "codex-provider-stable"
const accountA = { id: "local-account-a", upstreamId: "upstream-a", mapping: "nested/a.json", enabled: false, priority: 4 }
const accountB = { id: "local-account-b", upstreamId: "upstream-b", mapping: "b.json", enabled: true, priority: 8 }
const originalUnknown = { phase: "unknown", requestId: "request-unknown", lastMessage: "Redemption outcome unknown.", attemptCreditCount: 2, attemptInventoryKnown: false }
const originalRedeemed = { phase: "redeemed", requestId: "request-redeemed", blockedCreditCount: 3, blockedInventoryKnown: true }

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function jwt(accountId: string) {
  return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.signature`
}

function fixture(kind: "managed" | "external" = "managed") {
  const directory = mkdtempSync(join(tmpdir(), `rawroute-codex-${kind}-migration-`))
  directories.push(directory)
  const dataRoot = join(directory, kind === "managed" ? "managed" : "external-data")
  const proxyRoot = kind === "managed" ? join(dataRoot, "cliproxy") : join(directory, "external-cliproxy")
  const authDir = join(proxyRoot, "auth")
  mkdirSync(join(authDir, "nested"), { recursive: true })
  const config = join(proxyRoot, "config.yaml")
  const configBytes = Buffer.from(`config-version: 8\noauth:\n  auth-dir: "${authDir}"\nmanagement:\n  secret-key: synthetic-management-secret\n`)
  writeFileSync(config, configBytes)

  const authA = {
    type: "codex", access_token: "synthetic-access-a", refresh_token: "synthetic-refresh-a", id_token: jwt(accountA.upstreamId),
    account_id: accountA.upstreamId, email: "a@example.test", plan_type: "pro", expired: "2027-01-01T00:00:00.000Z",
    last_refresh: "2026-10-30T00:00:00.000Z", disabled: true, priority: accountA.priority,
  }
  const authB = {
    type: "codex", access_token: "synthetic-access-b", refresh_token: "synthetic-refresh-b", id_token: jwt(accountB.upstreamId),
    account_id: accountB.upstreamId, email: "b@example.test", plan_type: "plus", expired: "2027-02-01T00:00:00.000Z",
    last_refresh: "2026-10-29T00:00:00.000Z", disabled: false, priority: accountB.priority,
  }
  const authABytes = Buffer.from(JSON.stringify(authA))
  const authBBytes = Buffer.from(JSON.stringify(authB))
  writeFileSync(join(authDir, accountA.mapping), authABytes, { mode: 0o600 })
  writeFileSync(join(authDir, accountB.mapping), authBBytes, { mode: 0o600 })
  mkdirSync(join(authDir, "unmanaged"), { recursive: true })
  const unrelatedAuth = Buffer.from('{"type":"claude","access_token":"synthetic-unrelated-token"}')
  writeFileSync(join(authDir, "unmanaged", "other.json"), unrelatedAuth, { mode: 0o600 })

  const file = join(dataRoot, "rawroute.sqlite")
  mkdirSync(dataRoot, { recursive: true })
  const database = new Database(file)
  database.run("PRAGMA journal_mode = WAL")
  database.run(`CREATE TABLE rawroute_documents (
    path TEXT PRIMARY KEY,
    collection_path TEXT NOT NULL,
    document_id TEXT NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  database.run("CREATE INDEX rawroute_documents_collection_idx ON rawroute_documents (collection_path)")
  const insert = database.query("INSERT INTO rawroute_documents (path, collection_path, document_id, data, updated_at) VALUES (?, ?, ?, ?, ?)")
  const add = (collection: string, id: string, data: object, updatedAt = "2026-10-01T00:00:00.000Z") =>
    insert.run(`${collection}/${id}`, collection, id, JSON.stringify(data), updatedAt)
  const providerCollection = `${prefix}_workspaces/${workspaceId}/providers`
  add(providerCollection, providerId, { prefix: "codex", name: "Codex", apiKeyCount: 2, enabledApiKeyCount: 1 })
  const accountCollection = `${providerCollection}/${providerId}/apiKeys`
  add(accountCollection, accountA.id, {
    name: "Saved account A", key: "", credentialKind: "codex-cli-proxy", accountId: accountA.upstreamId,
    email: "old-a@example.test", planType: "old-plan", expiresAt: "old-expiry", lastRefresh: "old-refresh",
    cliProxyAuthFile: accountA.mapping, cliProxyAuthIndex: "private-index-a", cliProxyStatus: "active",
    cliProxyStatusMessage: "old runtime state", enabled: accountA.enabled, priority: accountA.priority,
    createdAt: "2026-01-01T00:00:00.000Z",
  })
  add(accountCollection, accountB.id, {
    name: "Saved account B", key: "", credentialKind: "codex-cli-proxy", accountId: accountB.upstreamId,
    email: "old-b@example.test", planType: "old-plan", cliProxyAuthFile: accountB.mapping,
    cliProxyAuthIndex: "private-index-b", enabled: accountB.enabled, priority: accountB.priority,
    createdAt: "2026-02-01T00:00:00.000Z",
  })
  const modelCollection = `${providerCollection}/${providerId}/models`
  add(modelCollection, "model-stable", { gatewayModelId: "codex/model-stable", upstreamModel: "model-stable", enabled: true })
  const resetCollection = `${prefix}_workspaces/${workspaceId}/codexResetAutomationAccounts`
  add(resetCollection, accountA.id, originalUnknown)
  add(resetCollection, accountB.id, originalRedeemed)
  add(`${prefix}_audit`, "audit-stable", { action: "credential.update", resource: "provider-credential", workspaceId })
  add(`${prefix}_workspace_deletions`, "deletion-stable", { state: "pending", completed: ["gateway-ai"] })
  add(`${prefix}_workspaces/${workspaceId}/unrelated`, "unrelated-stable", { retained: true })
  database.close()

  return { directory, file, authDir, config, configBytes, authABytes, authBBytes, unrelatedAuth }
}

function row(database: Database, path: string) {
  const value = database.query<{ data: string; updated_at: string }, [string]>("SELECT data, updated_at FROM rawroute_documents WHERE path = ?").get(path)
  return value ? { data: JSON.parse(value.data) as Record<string, unknown>, updatedAt: value.updated_at } : undefined
}

function migrationOptions(value: ReturnType<typeof fixture>, extra: Partial<Parameters<typeof migrateCodexCredentials>[1]> = {}) {
  return { authDir: value.authDir, config: value.config, ...extra }
}

for (const kind of ["managed", "external"] as const) {
  test(`${kind} CLIProxy files migrate by exact mapping while preserving workspace records and safety barriers`, () => {
    const value = fixture(kind)
    const expectedUnknownId = `account-${createHash("sha256").update(accountA.upstreamId).digest("hex")}`
    const expectedRedeemedId = `account-${createHash("sha256").update(accountB.upstreamId).digest("hex")}`

    expect(migrateCodexCredentials(value.file, migrationOptions(value))).toEqual({ applied: false, required: true, accounts: 2, resetRecords: 2 })
    expect(existsSync(`${value.file}.before-codex-credentials`)).toBe(false)
    expect(readFileSync(join(value.authDir, accountA.mapping))).toEqual(value.authABytes)
    const before = new Database(value.file, { readonly: true })
    try {
      expect(codexCredentialSchemaVersion(before)).toBeUndefined()
      expect(row(before, `${prefix}_workspaces/${workspaceId}/providers/${providerId}/apiKeys/${accountA.id}`)?.data.credentialKind).toBe("codex-cli-proxy")
    } finally { before.close() }
    expect(() => migrateCodexCredentials(value.file, migrationOptions(value, { apply: true }))).toThrow("--writers-stopped")
    expect(readFileSync(join(value.authDir, accountA.mapping))).toEqual(value.authABytes)

    const result = migrateCodexCredentials(value.file, migrationOptions(value, { apply: true, writersStopped: true }))
    expect(result).toMatchObject({ applied: true, required: false, accounts: 2, resetRecords: 2 })
    const backup = result.backup!
    expect(statSync(join(backup, "rawroute.sqlite")).mode & 0o777).toBe(0o600)
    expect(statSync(join(backup, "cliproxy-config.snapshot")).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(backup, "cliproxy-config.snapshot"))).toEqual(value.configBytes)
    expect(readFileSync(join(backup, "auth", accountA.mapping))).toEqual(value.authABytes)
    expect(readFileSync(join(backup, "auth", accountB.mapping))).toEqual(value.authBBytes)
    expect(statSync(join(backup, "auth", accountA.mapping)).mode & 0o777).toBe(0o600)
    expect(statSync(join(backup, "manifest.json")).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(value.authDir, accountA.mapping))).toEqual(value.authABytes)
    expect(readFileSync(join(value.authDir, accountB.mapping))).toEqual(value.authBBytes)
    expect(readFileSync(join(value.authDir, "unmanaged", "other.json"))).toEqual(value.unrelatedAuth)

    const database = new Database(value.file, { readonly: true })
    try {
      expect(codexCredentialSchemaVersion(database)).toBe(1)
      expect(codexResetSchemaVersion(database)).toBe(1)
      expect(row(database, `${prefix}_workspaces/${workspaceId}/providers/${providerId}`)?.data).toMatchObject({ apiKeyCount: 2, enabledApiKeyCount: 1 })
      expect(row(database, `${prefix}_workspaces/${workspaceId}/providers/${providerId}/apiKeys/${accountA.id}`)?.data).toMatchObject({
        name: "Saved account A", key: "", credentialKind: "codex-oauth", accountId: accountA.upstreamId,
        email: "a@example.test", planType: "pro", expiresAt: "2027-01-01T00:00:00.000Z",
        lastRefresh: "2026-10-30T00:00:00.000Z", enabled: false, priority: 4, createdAt: "2026-01-01T00:00:00.000Z",
      })
      expect(row(database, `${prefix}_workspaces/${workspaceId}/providers/${providerId}/apiKeys/${accountA.id}`)?.data).not.toHaveProperty("cliProxyAuthFile")
      expect(row(database, `${prefix}_workspaces/${workspaceId}/providers/${providerId}/apiKeys/${accountB.id}`)?.data).toMatchObject({
        name: "Saved account B", credentialKind: "codex-oauth", accountId: accountB.upstreamId,
        email: "b@example.test", planType: "plus", expiresAt: "2027-02-01T00:00:00.000Z",
        lastRefresh: "2026-10-29T00:00:00.000Z", enabled: true, priority: 8,
      })
      expect(row(database, `${prefix}_workspaces/${workspaceId}/codexCredentials/${accountA.id}`)?.data).toMatchObject({
        accessToken: "synthetic-access-a", refreshToken: "synthetic-refresh-a", idToken: expect.any(String),
        accountId: accountA.upstreamId, version: 1,
      })
      expect(row(database, `${prefix}_workspaces/${workspaceId}/codexCredentials/${accountB.id}`)?.data).toMatchObject({
        accessToken: "synthetic-access-b", refreshToken: "synthetic-refresh-b", accountId: accountB.upstreamId, version: 1,
      })
      expect(row(database, `${prefix}_workspaces/${workspaceId}/codexResetAutomationAccounts/${expectedUnknownId}`)?.data).toEqual(originalUnknown)
      expect(row(database, `${prefix}_workspaces/${workspaceId}/codexResetAutomationAccounts/${expectedRedeemedId}`)?.data).toEqual(originalRedeemed)
      expect(row(database, `${prefix}_workspaces/${workspaceId}/codexResetAutomationAccounts/${accountA.id}`)).toBeUndefined()
      expect(row(database, `${prefix}_workspaces/${workspaceId}/codexResetAutomationAccounts/${accountB.id}`)).toBeUndefined()
      expect(row(database, `${prefix}_workspaces/${workspaceId}/providers/${providerId}/models/model-stable`)?.data).toMatchObject({ gatewayModelId: "codex/model-stable" })
      expect(row(database, `${prefix}_audit/audit-stable`)?.data).toEqual({ action: "credential.update", resource: "provider-credential", workspaceId })
      expect(row(database, `${prefix}_workspace_deletions/deletion-stable`)?.data).toEqual({ state: "pending", completed: ["gateway-ai"] })
      expect(row(database, `${prefix}_workspaces/${workspaceId}/unrelated/unrelated-stable`)?.data).toEqual({ retained: true })
    } finally { database.close() }
    const backupDatabase = new Database(join(backup, "rawroute.sqlite"), { readonly: true })
    try {
      expect(backupDatabase.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
      expect(row(backupDatabase, `${prefix}_workspaces/${workspaceId}/providers/${providerId}/apiKeys/${accountA.id}`)?.data.credentialKind).toBe("codex-cli-proxy")
    } finally { backupDatabase.close() }
    expect(migrateCodexCredentials(value.file, migrationOptions(value))).toEqual({ applied: false, required: false, accounts: 0, resetRecords: 0 })
    expect(migrateCodexResetIdentity(value.file)).toEqual({ applied: false, required: false, records: 0 })
  })
}

test("a converted database no longer requires archived engine files for deployment previews", () => {
  const value = fixture()
  expect(migrateCodexCredentials(value.file, migrationOptions(value, { apply: true, writersStopped: true }))).toMatchObject({ applied: true, required: false })
  rmSync(value.authDir, { recursive: true, force: true })
  rmSync(value.config, { force: true })
  expect(migrateCodexCredentials(value.file, { authDir: "", config: "" })).toEqual({ applied: false, required: false, accounts: 0, resetRecords: 0 })
})

test("external deployment with no Codex accounts still receives required credential and reset schema markers", () => {
  const value = fixture("external")
  const accountCollection = `${prefix}_workspaces/${workspaceId}/providers/${providerId}/apiKeys`
  const resetCollection = `${prefix}_workspaces/${workspaceId}/codexResetAutomationAccounts`
  const database = new Database(value.file)
  database.run("DELETE FROM rawroute_documents WHERE collection_path IN (?, ?)", [accountCollection, resetCollection])
  database.close()
  rmSync(join(value.authDir, accountA.mapping), { force: true })
  rmSync(join(value.authDir, accountB.mapping), { force: true })

  expect(migrateCodexCredentials(value.file, migrationOptions(value))).toEqual({
    applied: false, required: true, accounts: 0, resetRecords: 0,
  })
  const applied = migrateCodexCredentials(value.file, migrationOptions(value, { apply: true, writersStopped: true }))
  expect(applied).toMatchObject({ applied: true, required: false, accounts: 0, resetRecords: 0 })
  const migrated = new Database(value.file, { readonly: true })
  try {
    expect(codexCredentialSchemaVersion(migrated)).toBe(1)
    expect(codexResetSchemaVersion(migrated)).toBe(1)
  } finally { migrated.close() }
  expect(readFileSync(join(value.authDir, "unmanaged", "other.json"))).toEqual(value.unrelatedAuth)
})

test("WAL data is included in the private SQLite backup and the original WAL remains readable", () => {
  const value = fixture()
  const child = Bun.spawnSync(["python3", "-c", `import os, sqlite3, sys\np=sys.argv[1]\ndb=sqlite3.connect(p)\ndb.execute('PRAGMA journal_mode=WAL')\ndb.execute('PRAGMA wal_autocheckpoint=0')\ndb.execute('INSERT INTO rawroute_documents(path,collection_path,document_id,data) VALUES(?,?,?,?)', ('${prefix}_workspaces/${workspaceId}/unrelated/wal-only','${prefix}_workspaces/${workspaceId}/unrelated','wal-only','{"included":true}'))\ndb.commit()\nos._exit(0)`, value.file])
  expect(child.exitCode).toBe(0)
  expect(existsSync(`${value.file}-wal`)).toBe(true)
  expect(statSync(`${value.file}-wal`).size).toBeGreaterThan(0)
  const result = migrateCodexCredentials(value.file, migrationOptions(value, { apply: true, writersStopped: true }))
  const backup = new Database(join(result.backup!, "rawroute.sqlite"), { readonly: true })
  try {
    expect(row(backup, `${prefix}_workspaces/${workspaceId}/unrelated/wal-only`)?.data).toEqual({ included: true })
    expect(backup.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
  } finally { backup.close() }
})

test("missing, ambiguous and mismatched auth sources fail closed without changing account rows", () => {
  const missing = fixture()
  let database = new Database(missing.file)
  database.run("UPDATE rawroute_documents SET data = json_set(data, '$.cliProxyAuthFile', 'missing.json') WHERE document_id = ?", [accountA.id])
  database.close()
  expect(() => migrateCodexCredentials(missing.file, migrationOptions(missing))).toThrow("missing")

  const ambiguous = fixture()
  database = new Database(ambiguous.file)
  const secondPath = `${prefix}_workspaces/${workspaceId}/providers/${providerId}/apiKeys/${accountB.id}`
  const secondData = JSON.parse(database.query<{ data: string }, [string]>("SELECT data FROM rawroute_documents WHERE path = ?").get(secondPath)!.data) as Record<string, unknown>
  database.run("UPDATE rawroute_documents SET data = ? WHERE path = ?", [JSON.stringify({ ...secondData, cliProxyAuthFile: accountA.mapping, accountId: accountA.upstreamId, enabled: false, priority: 4 }), secondPath])
  database.close()
  expect(() => migrateCodexCredentials(ambiguous.file, migrationOptions(ambiguous))).toThrow("mapped to multiple")

  const mismatch = fixture()
  database = new Database(mismatch.file)
  database.run("UPDATE rawroute_documents SET data = json_set(data, '$.accountId', 'wrong-upstream-account') WHERE document_id = ?", [accountA.id])
  database.close()
  expect(() => migrateCodexCredentials(mismatch.file, migrationOptions(mismatch))).toThrow("identity does not match")
})

test("the configured auth location and complete Codex source inventory must match exact database mappings", () => {
  const orphan = fixture()
  writeFileSync(join(orphan.authDir, "orphan.json"), JSON.stringify({ type: "codex", access_token: "orphan-token", account_id: accountA.upstreamId }))
  expect(() => migrateCodexCredentials(orphan.file, migrationOptions(orphan))).toThrow("no exact RawRoute mapping")
  const unchanged = new Database(orphan.file, { readonly: true })
  try { expect(codexCredentialSchemaVersion(unchanged)).toBeUndefined() } finally { unchanged.close() }

  const wrongConfig = fixture()
  writeFileSync(wrongConfig.config, `config-version: 8\noauth:\n  auth-dir: "${wrongConfig.directory}/another-auth-dir"\n`)
  expect(() => migrateCodexCredentials(wrongConfig.file, migrationOptions(wrongConfig))).toThrow("does not match CLIProxy config")

  const duplicateIdentity = fixture()
  writeFileSync(join(duplicateIdentity.authDir, "duplicate.json"), JSON.stringify({
    type: "codex", access_token: "duplicate-token", account_id: accountA.upstreamId,
  }))
  expect(() => migrateCodexCredentials(duplicateIdentity.file, migrationOptions(duplicateIdentity))).toThrow("no exact RawRoute mapping")
})

test("active SIWC sessions fail closed while inactive nested credentials do not replace outer OAuth", () => {
  const inactive = fixture()
  const outer = JSON.parse(readFileSync(join(inactive.authDir, accountA.mapping), "utf8")) as Record<string, unknown>
  outer.use_siwc = false
  outer.siwc = { access_token: "inactive-siwc-token", refresh_token: "inactive-siwc-refresh" }
  writeFileSync(join(inactive.authDir, accountA.mapping), JSON.stringify(outer))
  const imported = migrateCodexCredentials(inactive.file, migrationOptions(inactive, { apply: true, writersStopped: true }))
  const database = new Database(inactive.file, { readonly: true })
  try {
    expect(imported).toMatchObject({ applied: true, accounts: 2 })
    const secrets = row(database, `${prefix}_workspaces/${workspaceId}/codexCredentials/${accountA.id}`)?.data
    expect(secrets).toMatchObject({ accessToken: "synthetic-access-a" })
    expect(JSON.stringify(secrets)).not.toContain("inactive-siwc-token")
  } finally { database.close() }

  const active = fixture()
  const activeAuth = JSON.parse(readFileSync(join(active.authDir, accountA.mapping), "utf8")) as Record<string, unknown>
  activeAuth.use_siwc = true
  activeAuth.siwc = { access_token: "synthetic-active-siwc-token", refresh_token: "synthetic-active-siwc-refresh" }
  writeFileSync(join(active.authDir, accountA.mapping), JSON.stringify(activeAuth))
  expect(() => migrateCodexCredentials(active.file, migrationOptions(active))).toThrow("active SIWC session")
  expect(readFileSync(join(active.authDir, accountA.mapping), "utf8")).toBe(JSON.stringify(activeAuth))
})

test("imports multiple workspaces independently and preserves each local account identity", () => {
  const value = fixture()
  const otherWorkspace = "another-workspace"
  const otherProvider = "codex-provider-other"
  const otherCredential = "local-account-other"
  const otherUpstream = accountA.upstreamId
  const otherMapping = "other/other.json"
  mkdirSync(join(value.authDir, "other"), { recursive: true })
  writeFileSync(join(value.authDir, otherMapping), JSON.stringify({
    type: "codex", access_token: "synthetic-access-other", account_id: otherUpstream, email: "other@example.test",
  }))
  const database = new Database(value.file)
  const insert = database.query("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?)")
  const providerCollection = `${prefix}_workspaces/${otherWorkspace}/providers`
  insert.run(`${providerCollection}/${otherProvider}`, providerCollection, otherProvider, JSON.stringify({ prefix: "codex", apiKeyCount: 1, enabledApiKeyCount: 1 }))
  const accounts = `${providerCollection}/${otherProvider}/apiKeys`
  insert.run(`${accounts}/${otherCredential}`, accounts, otherCredential, JSON.stringify({
    name: "Other account", key: "", credentialKind: "codex-cli-proxy", accountId: otherUpstream,
    cliProxyAuthFile: otherMapping, enabled: true, priority: 0, createdAt: "2026-03-01T00:00:00.000Z",
  }))
  insert.run(`${prefix}_workspaces/${otherWorkspace}/codexResetAutomationAccounts/${otherCredential}`,
    `${prefix}_workspaces/${otherWorkspace}/codexResetAutomationAccounts`, otherCredential, JSON.stringify({ phase: "unknown", requestId: "other-request" }))
  database.close()

  const result = migrateCodexCredentials(value.file, migrationOptions(value, { apply: true, writersStopped: true }))
  expect(result).toMatchObject({ applied: true, accounts: 3, resetRecords: 3 })
  const read = new Database(value.file, { readonly: true })
  try {
    expect(row(read, `${prefix}_workspaces/${otherWorkspace}/providers/${otherProvider}/apiKeys/${otherCredential}`)?.data)
      .toMatchObject({ name: "Other account", credentialKind: "codex-oauth", accountId: otherUpstream, enabled: true, priority: 0 })
    expect(row(read, `${prefix}_workspaces/${otherWorkspace}/codexCredentials/${otherCredential}`)?.data)
      .toMatchObject({ accessToken: "synthetic-access-other", accountId: otherUpstream, version: 1 })
    const resetId = `account-${createHash("sha256").update(otherUpstream).digest("hex")}`
    expect(row(read, `${prefix}_workspaces/${otherWorkspace}/codexResetAutomationAccounts/${resetId}`)?.data)
      .toEqual({ phase: "unknown", requestId: "other-request" })
  } finally { read.close() }
})

test("reset identity collisions remain rejected within one workspace", () => {
  const value = fixture()
  const duplicateId = "local-account-duplicate"
  const mapping = "nested/duplicate.json"
  writeFileSync(join(value.authDir, mapping), JSON.stringify({
    type: "codex", access_token: "synthetic-duplicate-access", account_id: accountA.upstreamId, disabled: false, priority: 9,
  }))
  const database = new Database(value.file)
  const accountCollection = `${prefix}_workspaces/${workspaceId}/providers/${providerId}/apiKeys`
  database.run("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?)", [
    `${accountCollection}/${duplicateId}`, accountCollection, duplicateId,
    JSON.stringify({ name: "Duplicate source", key: "", credentialKind: "codex-cli-proxy", accountId: accountA.upstreamId, cliProxyAuthFile: mapping, enabled: true, priority: 9 }),
  ])
  const resets = `${prefix}_workspaces/${workspaceId}/codexResetAutomationAccounts`
  database.run("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?)", [
    `${resets}/${duplicateId}`, resets, duplicateId, JSON.stringify({ phase: "unknown", requestId: "duplicate-request" }),
  ])
  database.close()

  expect(() => migrateCodexCredentials(value.file, migrationOptions(value))).toThrow("Multiple reset records map to one Codex account")
  const unchanged = new Database(value.file, { readonly: true })
  try {
    expect(row(unchanged, `${accountCollection}/${duplicateId}`)?.data.credentialKind).toBe("codex-cli-proxy")
    expect(row(unchanged, `${resets}/${duplicateId}`)?.data).toEqual({ phase: "unknown", requestId: "duplicate-request" })
  } finally { unchanged.close() }
})

test("apply excludes concurrent SQLite writers before planning and cannot overwrite their committed priority", () => {
  const value = fixture()
  const accountPath = `${prefix}_workspaces/${workspaceId}/providers/${providerId}/apiKeys/${accountA.id}`
  const writer = new Database(value.file)
  writer.run("BEGIN IMMEDIATE")
  writer.run("UPDATE rawroute_documents SET data = data WHERE path = ?", [accountPath])
  expect(() => migrateCodexCredentials(value.file, migrationOptions(value, { apply: true, writersStopped: true }))).toThrow(/locked/i)
  expect(existsSync(`${value.file}.before-codex-credentials`)).toBe(false)
  writer.run("UPDATE rawroute_documents SET data = json_set(data, '$.priority', 3) WHERE path = ?", [accountPath])
  writer.run("COMMIT")
  writer.close()

  expect(() => migrateCodexCredentials(value.file, migrationOptions(value))).toThrow("priority does not match")
  const unchanged = new Database(value.file, { readonly: true })
  try { expect(row(unchanged, accountPath)?.data.priority).toBe(3) } finally { unchanged.close() }
})

test("v8 omitted disabled and priority fields preserve their effective defaults", () => {
  const value = fixture()
  const database = new Database(value.file)
  const accountPath = `${prefix}_workspaces/${workspaceId}/providers/${providerId}/apiKeys/${accountA.id}`
  const stored = JSON.parse(database.query<{ data: string }, [string]>("SELECT data FROM rawroute_documents WHERE path = ?").get(accountPath)!.data) as Record<string, unknown>
  delete stored.priority
  database.run("UPDATE rawroute_documents SET data = ? WHERE path = ?", [JSON.stringify({ ...stored, enabled: true }), accountPath])
  database.run("UPDATE rawroute_documents SET data = json_set(data, '$.enabledApiKeyCount', 2) WHERE document_id = ?", [providerId])
  database.close()
  const source = JSON.parse(readFileSync(join(value.authDir, accountA.mapping), "utf8")) as Record<string, unknown>
  delete source.disabled
  delete source.priority
  writeFileSync(join(value.authDir, accountA.mapping), JSON.stringify(source))

  const result = migrateCodexCredentials(value.file, migrationOptions(value, { apply: true, writersStopped: true }))
  expect(result).toMatchObject({ applied: true, accounts: 2 })
  const converted = new Database(value.file, { readonly: true })
  try { expect(row(converted, accountPath)?.data).toMatchObject({ enabled: true, priority: 0 }) } finally { converted.close() }
})

test("a failed transaction leaves accounts, safety records and schema markers untouched; retry uses a new backup", () => {
  const value = fixture()
  const failedBackup = join(value.directory, "failed-backup")
  const database = new Database(value.file)
  database.run(`CREATE TRIGGER fail_reset_move BEFORE INSERT ON rawroute_documents
    WHEN NEW.collection_path LIKE '%/codexResetAutomationAccounts'
    BEGIN SELECT RAISE(ABORT, 'synthetic interruption'); END`)
  database.close()
  expect(() => migrateCodexCredentials(value.file, migrationOptions(value, { apply: true, writersStopped: true, backupDir: failedBackup }))).toThrow("synthetic interruption")
  expect(existsSync(join(failedBackup, "rawroute.sqlite"))).toBe(true)
  expect(existsSync(join(value.authDir, accountA.mapping))).toBe(true)
  expect(existsSync(join(value.authDir, accountB.mapping))).toBe(true)

  const afterFailure = new Database(value.file, { readonly: true })
  try {
    expect(codexCredentialSchemaVersion(afterFailure)).toBeUndefined()
    expect(codexResetSchemaVersion(afterFailure)).toBeUndefined()
    expect(row(afterFailure, `${prefix}_workspaces/${workspaceId}/providers/${providerId}/apiKeys/${accountA.id}`)?.data.credentialKind).toBe("codex-cli-proxy")
    expect(row(afterFailure, `${prefix}_workspaces/${workspaceId}/codexCredentials/${accountA.id}`)).toBeUndefined()
  } finally { afterFailure.close() }

  const clean = new Database(value.file)
  clean.run("DROP TRIGGER fail_reset_move")
  clean.close()
  const retry = migrateCodexCredentials(value.file, migrationOptions(value, { apply: true, writersStopped: true, backupDir: join(value.directory, "retry-backup") }))
  expect(retry).toMatchObject({ applied: true, accounts: 2, resetRecords: 2 })
})
