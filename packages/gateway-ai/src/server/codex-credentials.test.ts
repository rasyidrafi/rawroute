import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { queryAudit } from "@rawroute/platform/server/audit"
import { closeLocalCache } from "@rawroute/platform/server/local-cache"
import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { appendAuditSqlite } from "@rawroute/platform/server/audit"
import { closeLocalDatabase, getDatabase, LocalTransaction, withTransaction, type DatabaseClient } from "@rawroute/platform/server/database"
import { collectionPrefix } from "@rawroute/platform/server/storage-config"
import { Database } from "bun:sqlite"
import { hasCodexCredentialSchema } from "@rawroute/gateway-ai/server/maintenance/codex-credentials"
import { hasCodexResetSchema } from "@rawroute/gateway-ai/server/maintenance/codex-reset"

import { aiLocalDatabase } from "./local-db"
import { _resetMemoryBackend, deleteProvider, deleteProviderApiKey, listProviders, providerApiKeyRef, upsertProvider, upsertProviderApiKey } from "./store"
import {
  CodexCredentialConflictError,
  CodexCredentialMissingError,
  deleteCodexCredential,
  getCodexCredential,
  listCodexCredentials,
  readCodexCredentialSecrets,
  refreshCodexCredential,
  registerCodexCredential,
  updateCodexCredential,
} from "./codex-credentials"
import { applyCodexCredentialSecrets, codexCredentialSecretsRef, stageCodexCredentialSecrets } from "./codex-credential-secrets"

const defaultWorkspace = { id: DEFAULT_WORKSPACE_ID, storageMode: "scoped" as const }
let temporaryDirectory: string | undefined

const providerInput = {
  name: "Codex OAuth",
  prefix: "codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  protocol: "openai-responses" as const,
  authType: "bearer" as const,
  headers: {},
  enabled: true,
}

function registration(accessToken: string) {
  return {
    accountId: "acct-test-account",
    email: "user@example.com",
    planType: "pro",
    secrets: {
      accessToken,
      refreshToken: `refresh-${accessToken}`,
      idToken: `id-${accessToken}`,
      expiresAt: "2026-11-01T00:00:00Z",
      lastRefresh: "2026-10-30T00:00:00Z",
    },
  }
}

const tokenFragments = ["access-token-one", "refresh-access-token-one", "id-access-token-one", "access-token-two", "rolled-back-token"]

function expectNoTokens(value: unknown) {
  const serialized = JSON.stringify(value)
  for (const fragment of tokenFragments) expect(serialized).not.toContain(fragment)
}

async function setupProvider() {
  const provider = await upsertProvider(providerInput)
  return provider.id
}

beforeEach(async () => {
  await closeLocalDatabase()
  await closeLocalCache()
  Object.assign(process.env, { NODE_ENV: "test", STORAGE_BACKEND: "memory", SQLITE_PATH: ":memory:" })
  globalThis.__rawrouteMemoryAudit = []
  _resetMemoryBackend()
})

afterEach(async () => {
  await closeLocalDatabase()
  await closeLocalCache()
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

async function useSqlite() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "rawroute-codex-credentials-"))
  Object.assign(process.env, { STORAGE_BACKEND: "sqlite", SQLITE_PATH: join(temporaryDirectory, "test.sqlite") })
}

function tokenFreeAccountAssertions(account: { key?: string; credentialKind?: string; accountId?: string; email?: string; planType?: string; expiresAt?: string; lastRefresh?: string }) {
  expect(account.credentialKind).toBe("codex-oauth")
  expect(account.key).toBe("")
  expect(account.accountId).toBe("acct-test-account")
  expect(account.email).toBe("user@example.com")
  expect(account.planType).toBe("pro")
  expect(account.expiresAt).toBe("2026-11-01T00:00:00Z")
  expect(account.lastRefresh).toBe("2026-10-30T00:00:00Z")
}

test("register keeps tokens out of public records, secrets readable server-side, and audit redacted", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))
    tokenFreeAccountAssertions(account)

    expect(await readCodexCredentialSecrets(account.id)).toMatchObject({ accessToken: "access-token-one", refreshToken: "refresh-access-token-one", idToken: "id-access-token-one", version: 1 })

    for (const visible of [await listCodexCredentials(providerId), [await getCodexCredential(providerId, account.id)!]]) {
      expect(visible).toHaveLength(1)
      tokenFreeAccountAssertions(visible[0]!)
    }

    const audit = await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID })
    const created = audit.filter(event => event.resource === "provider-credential" && event.action === "credential.create")
    expect(created.length).toBeGreaterThan(0)
    expectNoTokens(audit)
  })
})

test("SQLite register persists the account, session and redacted audit", async () => {
  await useSqlite()
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))
    tokenFreeAccountAssertions(account)

    await closeLocalDatabase()
    const persisted = await getCodexCredential(providerId, account.id)
    expect(persisted?.id).toBe(account.id)
    tokenFreeAccountAssertions(persisted!)
    expect(await readCodexCredentialSecrets(account.id)).toMatchObject({ accessToken: "access-token-one", version: 1 })

    const audit = await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID })
    expect(audit.filter(event => event.resource === "provider-credential" && event.action === "credential.create").length).toBeGreaterThan(0)
    expectNoTokens(audit)
  })
})

test("re-registration keeps the account identity stable and replaces the session", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const first = await registerCodexCredential(providerId, registration("access-token-one"))
    const second = await registerCodexCredential(providerId, { ...registration("access-token-two"), email: "changed@example.com" })

    expect(second.id).toBe(first.id)
    expect(second.email).toBe("changed@example.com")
    expect(await readCodexCredentialSecrets(first.id)).toMatchObject({ accessToken: "access-token-two", version: 2 })
    expect((await listCodexCredentials(providerId)).length).toBe(1)
  })
})

test("credentials stay workspace-scoped", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))
    expect(account.id).toBeTruthy()

    await runInWorkspace({ id: "other-workspace", storageMode: "scoped" }, async () => {
      const otherProviderId = await setupProvider()
      expect(await listCodexCredentials(otherProviderId)).toHaveLength(0)
      expect(await getCodexCredential(otherProviderId, account.id)).toBeUndefined()
      expect(await readCodexCredentialSecrets(account.id)).toBeUndefined()
      await expect(refreshCodexCredential(otherProviderId, account.id, () => Promise.resolve(undefined))).rejects.toBeInstanceOf(CodexCredentialMissingError)
      await deleteCodexCredential(otherProviderId, account.id)
    })

    expect(await getCodexCredential(providerId, account.id)).toBeDefined()
    expect((await readCodexCredentialSecrets(account.id))?.accessToken).toBe("access-token-one")
  })
})

test("refresh renews the session under a lock and declines leave it unchanged", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))

    const renewed = await refreshCodexCredential(providerId, account.id, async current => ({ accessToken: `next-${current.version}`, refreshToken: "refresh-token-one" }))
    expect(renewed).toMatchObject({ accessToken: "next-1", version: 2 })

    const declined = await refreshCodexCredential(providerId, account.id, async () => undefined)
    expect(declined).toMatchObject({ accessToken: "next-1", version: 2 })

    const observed: number[] = []
    const first = refreshCodexCredential(providerId, account.id, async current => { observed.push(current.version); await new Promise(resolve => setTimeout(resolve, 5)); return { accessToken: `winner-${current.version}` } })
    const second = refreshCodexCredential(providerId, account.id, async current => { observed.push(current.version); await new Promise(resolve => setTimeout(resolve, 1)); return { accessToken: `winner-${current.version}` } })
    await Promise.all([first, second])
    expect(observed.sort()).toEqual([2, 3])
    expect((await readCodexCredentialSecrets(account.id))?.version).toBe(4)
  })
})

test("SQLite refresh applies compare-and-swap and rejects stale or deleted sessions", async () => {
  await useSqlite()
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))

    await expect(applyCodexCredentialSecrets(account.id, 4242, { accessToken: "stale-token" })).rejects.toBeInstanceOf(CodexCredentialConflictError)
    await expect(applyCodexCredentialSecrets("missing-credential", 1, { accessToken: "stale-token" })).rejects.toBeInstanceOf(CodexCredentialMissingError)
    expect((await readCodexCredentialSecrets(account.id))?.accessToken).toBe("access-token-one")

    await deleteCodexCredential(providerId, account.id)
    await expect(applyCodexCredentialSecrets(account.id, 1, { accessToken: "resurrected-token" })).rejects.toBeInstanceOf(CodexCredentialMissingError)
  })
})

test("a deleted credential cannot be resurrected by an in-flight refresh", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))

    await expect(refreshCodexCredential(providerId, account.id, async () => {
      await deleteCodexCredential(providerId, account.id)
      return { accessToken: "resurrected-token" }
    })).rejects.toBeInstanceOf(CodexCredentialMissingError)

    expect(await listCodexCredentials(providerId)).toHaveLength(0)
    expect(await readCodexCredentialSecrets(account.id)).toBeUndefined()
    expect(await getCodexCredential(providerId, account.id)).toBeUndefined()
  })
})

test("identity updates never touch the session or expose tokens", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))

    const renamed = await updateCodexCredential(providerId, account.id, { name: "Renamed account", planType: "team", enabled: false })
    expect(renamed.name).toBe("Renamed account")
    expect(renamed.planType).toBe("team")
    expect(renamed.enabled).toBe(false)
    expect(renamed.key).toBe("")

    expect(await readCodexCredentialSecrets(account.id)).toMatchObject({ accessToken: "access-token-one", version: 1 })
    expectNoTokens(await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID }))
  })
})

test("deletion removes the account with its session and stays idempotent", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))

    await deleteCodexCredential(providerId, account.id)
    await deleteCodexCredential(providerId, account.id)

    expect(await listCodexCredentials(providerId)).toHaveLength(0)
    expect(await readCodexCredentialSecrets(account.id)).toBeUndefined()
    const audit = await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID })
    expect(audit.filter(event => event.action === "credential.revoke").length).toBeGreaterThan(0)
    expectNoTokens(audit)
  })
})

test("generic credential deletion removes the Codex session too", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))

    await deleteProviderApiKey(providerId, account.id)
    expect(await readCodexCredentialSecrets(account.id)).toBeUndefined()
  })
})

test("the codex credential API rejects other credential kinds", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const apiKey = await upsertProviderApiKey(providerId, { name: "Plain key", key: "sk-plain" })

    await expect(updateCodexCredential(providerId, apiKey.id, { name: "Renamed" })).rejects.toBeInstanceOf(CodexCredentialMissingError)
    await expect(deleteCodexCredential(providerId, apiKey.id)).rejects.toThrow("Only Codex OAuth credentials")
    expect(await getCodexCredential(providerId, apiKey.id)).toBeUndefined()
  })
})

test("a key value smuggled into a Codex credential is dropped", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))
    const smuggled = await upsertProviderApiKey(providerId, { originalId: account.id, key: "smuggled-secret-value", name: "Codex account" })

    expect(smuggled.key).toBe("")
    expect(await readCodexCredentialSecrets(account.id)).toMatchObject({ accessToken: "access-token-one" })
  })
})

test("SQLite writes roll back with their audit when the owning transaction fails", async () => {
  await useSqlite()
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))
    const auditCollection = `${collectionPrefix()}_audit`

    const auditRowCount = async (client?: DatabaseClient) => {
      const result = client
        ? await client.query("SELECT path FROM rawroute_documents WHERE collection_path = $1", [auditCollection])
        : await withTransaction(client => client.query("SELECT path FROM rawroute_documents WHERE collection_path = $1", [auditCollection]))
      return result.rows.length
    }

    const before = await auditRowCount()
    await expect(withTransaction(async (client) => {
      const transaction = new LocalTransaction(client)
      await stageCodexCredentialSecrets(transaction, account.id, account.accountId!, { accessToken: "rolled-back-token" })
      // A durable audit row is executed directly against the open transaction.
      appendAuditSqlite(getDatabase(), { action: "credential.update", resource: "provider-credential", workspaceId: DEFAULT_WORKSPACE_ID, result: "success" })
      expect(await auditRowCount(client)).toBe(before + 1)
      throw new Error("deliberate failure")
    })).rejects.toThrow("deliberate failure")

    // The executed audit write and the staged session write are both gone.
    expect(await auditRowCount()).toBe(before)
    expect((await readCodexCredentialSecrets(account.id))?.accessToken).toBe("access-token-one")
    expectNoTokens(await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID }))
  })
})

test("refresh mirrors renewed expiry onto the account record and keeps an omitted expiry", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))

    const renewed = await refreshCodexCredential(providerId, account.id, async () => ({
      accessToken: "access-token-two",
      refreshToken: "refresh-access-token-two",
      expiresAt: "2026-12-01T00:00:00Z",
    }))
    expect(renewed).toMatchObject({ accessToken: "access-token-two", expiresAt: "2026-12-01T00:00:00Z", version: 2 })
    expect(renewed.lastRefresh).toBeTruthy()

    const after = await getCodexCredential(providerId, account.id)
    expect(after?.expiresAt).toBe("2026-12-01T00:00:00Z")
    expect(after?.lastRefresh).toBe(renewed.lastRefresh)
    expect(after?.email).toBe("user@example.com")
    expect(after?.key).toBe("")
    expectNoTokens(after)
    expect(await readCodexCredentialSecrets(account.id)).toMatchObject({ accessToken: "access-token-two", expiresAt: "2026-12-01T00:00:00Z", lastRefresh: renewed.lastRefresh, version: 2 })

    // Omitting expiry keeps the previously recorded expiry everywhere: the
    // returned session, the public record and the stored secrets agree.
    const renewedAgain = await refreshCodexCredential(providerId, account.id, async () => ({ accessToken: "access-token-three" }))
    expect(renewedAgain.expiresAt).toBe("2026-12-01T00:00:00Z")
    const kept = await getCodexCredential(providerId, account.id)
    expect(kept?.expiresAt).toBe("2026-12-01T00:00:00Z")
    expect(kept?.lastRefresh).toBe(renewedAgain.lastRefresh)
    const secrets = await readCodexCredentialSecrets(account.id)
    expect(secrets).toMatchObject({ accessToken: "access-token-three", expiresAt: "2026-12-01T00:00:00Z", lastRefresh: renewedAgain.lastRefresh, version: 3 })
    expect(renewedAgain.expiresAt).toBe(kept?.expiresAt)
    expect(kept?.expiresAt).toBe(secrets?.expiresAt)
  })
})

test("SQLite refresh mirrors renewed expiry and persists it across restarts", async () => {
  await useSqlite()
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))

    const renewed = await refreshCodexCredential(providerId, account.id, async () => ({ accessToken: "access-token-two", expiresAt: "2026-12-01T00:00:00Z" }))
    const after = await getCodexCredential(providerId, account.id)
    expect(after?.expiresAt).toBe("2026-12-01T00:00:00Z")
    expect(after?.lastRefresh).toBe(renewed.lastRefresh)

    // An omitted expiry keeps the prior value identically in both records.
    const renewedAgain = await refreshCodexCredential(providerId, account.id, async () => ({ accessToken: "access-token-three" }))
    expect(renewedAgain.expiresAt).toBe("2026-12-01T00:00:00Z")
    const kept = await getCodexCredential(providerId, account.id)
    const secrets = await readCodexCredentialSecrets(account.id)
    expect(renewedAgain.expiresAt).toBe(kept?.expiresAt)
    expect(kept?.expiresAt).toBe(secrets?.expiresAt)
    expect(secrets?.accessToken).toBe("access-token-three")

    await closeLocalDatabase()
    const persisted = await getCodexCredential(providerId, account.id)
    expect(persisted?.expiresAt).toBe("2026-12-01T00:00:00Z")
    expect(persisted?.lastRefresh).toBe(renewedAgain.lastRefresh)
    expect(await readCodexCredentialSecrets(account.id)).toMatchObject({ accessToken: "access-token-three", expiresAt: "2026-12-01T00:00:00Z", version: 3 })
  })
})

test("provider deletion removes Codex sessions and blocks an in-flight refresh", async () => {
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))
    expect(await readCodexCredentialSecrets(account.id)).toBeDefined()

    await expect(refreshCodexCredential(providerId, account.id, async () => {
      await deleteProvider(providerId)
      return { accessToken: "resurrected-token", expiresAt: "2026-12-01T00:00:00Z" }
    })).rejects.toBeInstanceOf(CodexCredentialMissingError)

    expect(await readCodexCredentialSecrets(account.id)).toBeUndefined()
    expect(await getCodexCredential(providerId, account.id)).toBeUndefined()
    expectNoTokens(await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID }))
  })
})

test("SQLite provider deletion removes Codex sessions with the public accounts", async () => {
  await useSqlite()
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))
    const secretsCollection = `${collectionPrefix()}_workspaces/${DEFAULT_WORKSPACE_ID}/codexCredentials`
    const secretsRowCount = async () => (await withTransaction(client => client.query("SELECT path FROM rawroute_documents WHERE collection_path = $1", [secretsCollection]))).rows.length

    expect(await secretsRowCount()).toBe(1)
    await deleteProvider(providerId)
    expect(await secretsRowCount()).toBe(0)
    expect(await readCodexCredentialSecrets(account.id)).toBeUndefined()

    await expect(refreshCodexCredential(providerId, account.id, async () => ({ accessToken: "resurrected-token" }))).rejects.toBeInstanceOf(CodexCredentialMissingError)
    const audit = await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID })
    expect(audit.filter(event => event.action === "credential.revoke").length).toBeGreaterThan(0)
    expectNoTokens(audit)
  })
})

test("SQLite: a deleted credential cannot be resurrected by an in-flight refresh", async () => {
  await useSqlite()
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))

    await expect(refreshCodexCredential(providerId, account.id, async () => {
      await deleteCodexCredential(providerId, account.id)
      return { accessToken: "resurrected-token" }
    })).rejects.toBeInstanceOf(CodexCredentialMissingError)

    expect(await listCodexCredentials(providerId)).toHaveLength(0)
    expect(await readCodexCredentialSecrets(account.id)).toBeUndefined()
    expect(await getCodexCredential(providerId, account.id)).toBeUndefined()
  })
})

test("SQLite rolls back an executed session write when the owning transaction fails", async () => {
  await useSqlite()
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    const account = await registerCodexCredential(providerId, registration("access-token-one"))
    const secretsPath = `${collectionPrefix()}_workspaces/${DEFAULT_WORKSPACE_ID}/codexCredentials/${account.id}`
    const secretsRow = [secretsPath, `${collectionPrefix()}_workspaces/${DEFAULT_WORKSPACE_ID}/codexCredentials`, account.id, JSON.stringify({ accessToken: "executed-then-rolled-back", accountId: account.accountId, version: 4242 })]

    // The session row is genuinely executed inside the open transaction and
    // visible to its own reads; the deliberate failure must roll it back.
    await expect(withTransaction(async (client) => {
      await client.query("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES ($1, $2, $3, $4) ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data", secretsRow)
      const present = await client.query("SELECT data FROM rawroute_documents WHERE path = $1", [secretsPath])
      expect((present.rows[0]!.data as { accessToken?: string }).accessToken).toBe("executed-then-rolled-back")
      throw new Error("deliberate failure")
    })).rejects.toThrow("deliberate failure")

    // The queued write path rolls back the same way when a sibling operation
    // fails during commit after it has executed.
    await expect(aiLocalDatabase().runTransaction((transaction) => {
      transaction.set(codexCredentialSecretsRef(account.id), { accessToken: "executed-then-rolled-back", accountId: account.accountId!, version: 4242 })
      transaction.create(providerApiKeyRef(providerId, account.id), { name: "conflict" })
      return Promise.resolve()
    })).rejects.toThrow()

    const secrets = await readCodexCredentialSecrets(account.id)
    expect(secrets?.accessToken).toBe("access-token-one")
    expect(secrets?.version).toBe(1)
    expectNoTokens(await queryAudit({ workspaceId: DEFAULT_WORKSPACE_ID }))
  })
})

test("a populated database without Codex schema markers is refused at startup", async () => {
  await useSqlite()
  const sqlitePath = join(temporaryDirectory!, "test.sqlite")
  await runInWorkspace(defaultWorkspace, async () => {
    const providerId = await setupProvider()
    await registerCodexCredential(providerId, registration("access-token-one"))
    expect((await listCodexCredentials(providerId)).length).toBe(1)
  })
  await closeLocalDatabase()

  // A database from before the feature: documents present, schema marker absent.
  const external = new Database(sqlitePath)
  try {
    external.run("DROP TABLE IF EXISTS ai_codex_credential_schema")
    external.run("DROP TABLE IF EXISTS ai_codex_reset_schema")
  } finally {
    external.close()
  }
  _resetMemoryBackend()

  await expect(runInWorkspace(defaultWorkspace, () => listProviders())).rejects.toThrow("scripts/migrations/codex-credentials.ts")
  const unchanged = new Database(sqlitePath, { readonly: true })
  try {
    expect(hasCodexCredentialSchema(unchanged)).toBe(false)
    expect(hasCodexResetSchema(unchanged)).toBe(false)
    expect(unchanged.query("SELECT 1 FROM rawroute_documents WHERE collection_path LIKE '%/providers/%/apiKeys' LIMIT 1").get()).toBeDefined()
  } finally { unchanged.close() }
})

test("a fresh SQLite database receives both Codex schema markers at startup", async () => {
  await useSqlite()
  await runInWorkspace(defaultWorkspace, async () => {
    expect(await listProviders()).toEqual([])
  })
  await closeLocalDatabase()
  const database = new Database(join(temporaryDirectory!, "test.sqlite"), { readonly: true })
  try {
    expect(hasCodexCredentialSchema(database)).toBe(true)
    expect(hasCodexResetSchema(database)).toBe(true)
  } finally { database.close() }
})
