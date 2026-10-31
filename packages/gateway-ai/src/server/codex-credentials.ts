import { getDatabase, FieldValue } from "@rawroute/platform/server/database"
import { appendMemoryAudit } from "@rawroute/platform/server/audit"
import { isMemoryBackend } from "@rawroute/platform/server/storage-config"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"

import type { ProviderApiKey } from "../contracts/domain"
import { aiLocalDatabase } from "./local-db"
import {
  bumpRoutingRevision,
  deleteProviderApiKey,
  getProviderApiKey,
  invalidateRoutingCaches,
  listProviderApiKeys,
  providerApiKeysRef,
  providerApiKeyRef,
  providerRef,
  stripUndefined,
  upsertProviderApiKey,
} from "./store"
import {
  applyCodexCredentialSecrets,
  CodexCredentialConflictError,
  type CodexCredentialSecrets,
  type CodexCredentialSecretsInput,
  CodexCredentialMissingError,
  readCodexCredentialSecrets,
  setMemoryCodexCredentialSecrets,
  stageCodexCredentialSecrets,
} from "./codex-credential-secrets"
import { assertCodexCredentialSchema } from "./codex-credential-schema"

export type { CodexCredentialSecrets, CodexCredentialSecretsInput }
export { CodexCredentialConflictError, CodexCredentialMissingError, readCodexCredentialSecrets }

/** Identity and session material for a workspace-owned Codex account. */
export interface CodexCredentialRegistration {
  /** Stable upstream ChatGPT account identifier; anchors re-registration. */
  accountId: string
  email?: string
  planType?: string
  name?: string
  secrets: CodexCredentialSecretsInput
}

export interface CodexCredentialPatch {
  name?: string
  email?: string
  planType?: string
  /** Upstream session metadata; token values belong to the secrets store only. */
  expiresAt?: string
  lastRefresh?: string
  enabled?: boolean
}

export type CodexCredentialRenewer = (current: CodexCredentialSecrets) => Promise<CodexCredentialSecretsInput | undefined>

const codexCredentialLocks = new Map<string, Promise<unknown>>()

function withCodexCredentialLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = codexCredentialLocks.get(key)
  // Run the next task even when the previous one rejected; the lock only
  // serializes, it never propagates failures to the waiter.
  const promise = (previous ?? Promise.resolve()).then(task, task)
  codexCredentialLocks.set(key, promise)
  promise.catch(() => undefined).finally(() => {
    if (codexCredentialLocks.get(key) === promise) codexCredentialLocks.delete(key)
  })
  return promise
}

function validateCodexCredentialRegistration(input: CodexCredentialRegistration) {
  if (typeof input.accountId !== "string" || !input.accountId.trim()) throw new Error("Codex account ID is required.")
  if (typeof input.secrets?.accessToken !== "string" || !input.secrets.accessToken.trim()) throw new Error("Codex access token is required.")
  if (input.email !== undefined && (typeof input.email !== "string" || !input.email.trim())) throw new Error("Codex account email is invalid.")
  if (input.planType !== undefined && (typeof input.planType !== "string" || !input.planType.trim())) throw new Error("Codex plan type is invalid.")
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim())) throw new Error("Codex account name is invalid.")
  if (input.name !== undefined && input.name.trim().length > 80) throw new Error("Codex account name must be 80 characters or fewer.")
}

function storedCodexCredential(apiKey: ProviderApiKey) {
  return stripUndefined({
    name: apiKey.name,
    key: "",
    credentialKind: "codex-oauth",
    accountId: apiKey.accountId,
    email: apiKey.email,
    planType: apiKey.planType,
    expiresAt: apiKey.expiresAt,
    lastRefresh: apiKey.lastRefresh,
    enabled: apiKey.enabled,
    priority: apiKey.priority,
    createdAt: apiKey.createdAt,
  })
}

/** Create or re-register a Codex account; the account ID is stable across re-logins. */
export async function registerCodexCredential(providerId: string, input: CodexCredentialRegistration): Promise<ProviderApiKey> {
  validateCodexCredentialRegistration(input)
  const apiKey = await withCodexCredentialLock(`${currentWorkspaceId()}:register:${providerId}:${input.accountId}`, () =>
    isMemoryBackend() ? memoryRegisterCodexCredential(providerId, input) : sqliteRegisterCodexCredential(providerId, input),
  )
  invalidateRoutingCaches()
  return apiKey
}

async function sqliteRegisterCodexCredential(providerId: string, input: CodexCredentialRegistration): Promise<ProviderApiKey> {
  return aiLocalDatabase().runTransaction(async (transaction) => {
    assertCodexCredentialSchema(getDatabase())
    const providerSnapshot = await transaction.get(providerRef(providerId))
    if (!providerSnapshot.exists) throw new Error("Provider is missing.")
    const matches = await transaction.get(providerApiKeysRef(providerId).where("accountId", "==", input.accountId))
    const existing = matches.docs
      .map((document) => ({ ...document.data(), id: document.id, providerId }) as ProviderApiKey)
      .find((account) => account.credentialKind === "codex-oauth")
    const credentialId = existing?.id || providerApiKeysRef(providerId).doc().id
    const apiKey: ProviderApiKey = {
      ...(existing || {}),
      id: credentialId,
      providerId,
      name: input.name?.trim() || existing?.name || input.email || input.accountId,
      key: "",
      credentialKind: "codex-oauth",
      accountId: input.accountId,
      email: input.email || existing?.email,
      planType: input.planType || existing?.planType,
      expiresAt: input.secrets.expiresAt,
      lastRefresh: input.secrets.lastRefresh,
      enabled: existing?.enabled ?? true,
      priority: existing?.priority,
      createdAt: existing?.createdAt || new Date().toISOString(),
    }
    transaction.set(providerApiKeyRef(providerId, credentialId), storedCodexCredential(apiKey))
    if (!existing) {
      transaction.update(providerRef(providerId), { apiKeyCount: FieldValue.increment(1), enabledApiKeyCount: FieldValue.increment(apiKey.enabled ? 1 : 0) })
    } else if (existing.enabled !== apiKey.enabled) {
      transaction.update(providerRef(providerId), { enabledApiKeyCount: FieldValue.increment(apiKey.enabled ? 1 : -1) })
    }
    bumpRoutingRevision(transaction)
    await stageCodexCredentialSecrets(transaction, credentialId, input.accountId, input.secrets)
    return apiKey
  })
}

async function memoryRegisterCodexCredential(providerId: string, input: CodexCredentialRegistration): Promise<ProviderApiKey> {
  const accounts = await listProviderApiKeys(providerId)
  const existing = accounts.find((account) => account.credentialKind === "codex-oauth" && account.accountId === input.accountId)
  const apiKey = await upsertProviderApiKey(providerId, {
    ...(existing ? { originalId: existing.id } : {}),
    name: input.name?.trim() || existing?.name || input.email || input.accountId,
    key: "",
    credentialKind: "codex-oauth",
    accountId: input.accountId,
    email: input.email || existing?.email,
    planType: input.planType || existing?.planType,
    expiresAt: input.secrets.expiresAt,
    lastRefresh: input.secrets.lastRefresh,
    priority: existing?.priority,
  })
  setMemoryCodexCredentialSecrets(apiKey.id, input.accountId, input.secrets)
  return apiKey
}

/** Public account records for Codex credentials; never includes token values. */
export async function listCodexCredentials(providerId: string): Promise<ProviderApiKey[]> {
  return (await listProviderApiKeys(providerId)).filter((account) => account.credentialKind === "codex-oauth")
}

export async function getCodexCredential(providerId: string, credentialId: string): Promise<ProviderApiKey | undefined> {
  const account = await getProviderApiKey(providerId, credentialId)
  return account?.credentialKind === "codex-oauth" ? account : undefined
}

async function requireCodexCredential(providerId: string, credentialId: string): Promise<ProviderApiKey> {
  const account = await getCodexCredential(providerId, credentialId)
  if (!account) throw new CodexCredentialMissingError("Codex credential not found.")
  return account
}

/** Update public identity/session metadata; token renewal uses the refresh API. */
export async function updateCodexCredential(providerId: string, credentialId: string, patch: CodexCredentialPatch): Promise<ProviderApiKey> {
  const existing = await requireCodexCredential(providerId, credentialId)
  return upsertProviderApiKey(providerId, {
    originalId: existing.id,
    ...stripUndefined({
      name: patch.name,
      email: patch.email,
      planType: patch.planType,
      expiresAt: patch.expiresAt,
      lastRefresh: patch.lastRefresh,
      enabled: patch.enabled,
    }),
  })
}

/**
 * Apply a renewed session together with its public account metadata. The
 * compare-and-swap write and the public `expiresAt`/`lastRefresh` mirror land
 * in one transaction; the account is re-verified inside it so a credential
 * (or provider) deleted while the renewer was exchanging upstream tokens
 * cannot be written back over. Expiry and refresh timestamps are already
 * normalized by the caller, so both records persist identical values.
 */
async function applyCodexCredentialSession(providerId: string, credentialId: string, expectedVersion: number, renewed: CodexCredentialSecretsInput): Promise<CodexCredentialSecrets> {
  if (isMemoryBackend()) {
    await requireCodexCredential(providerId, credentialId)
    const applied = await applyCodexCredentialSecrets(credentialId, expectedVersion, renewed)
    await upsertProviderApiKey(providerId, {
      originalId: credentialId,
      expiresAt: renewed.expiresAt,
      lastRefresh: renewed.lastRefresh,
    })
    return applied
  }
  return applyCodexCredentialSecrets(credentialId, expectedVersion, renewed, async (transaction) => {
    const snapshot = await transaction.get(providerApiKeyRef(providerId, credentialId))
    const account = snapshot.exists ? snapshot.data() as ProviderApiKey : undefined
    if (!account || account.credentialKind !== "codex-oauth") throw new CodexCredentialMissingError()
    transaction.set(providerApiKeyRef(providerId, credentialId), stripUndefined({
      expiresAt: renewed.expiresAt,
      lastRefresh: renewed.lastRefresh,
    }), { merge: true })
  })
}

/**
 * Renew session material under a per-credential lock with compare-and-swap
 * persistence. `renew` runs outside the database transaction so upstream token
 * exchange never extends it; the write then applies only against the version
 * the renewer read, so it cannot overwrite a newer session or resurrect a
 * credential deleted in the meantime. Returns the stored session: either the
 * renewed one, or the unchanged current one when `renew` declines.
 */
export async function refreshCodexCredential(providerId: string, credentialId: string, renew: CodexCredentialRenewer): Promise<CodexCredentialSecrets> {
  return withCodexCredentialLock(`${currentWorkspaceId()}:refresh:${providerId}:${credentialId}`, async () => {
    await requireCodexCredential(providerId, credentialId)
    const current = await readCodexCredentialSecrets(credentialId)
    if (!current) throw new CodexCredentialMissingError()
    const next = await renew(current)
    if (!next) return current
    // Normalize once: an omitted expiry keeps the prior session's value and the
    // refresh timestamp always advances, so secrets and public record agree.
    const renewed = { ...next, expiresAt: next.expiresAt ?? current.expiresAt, lastRefresh: next.lastRefresh ?? new Date().toISOString() }
    const applied = await applyCodexCredentialSession(providerId, credentialId, current.version, renewed)
    if (isMemoryBackend()) {
      appendMemoryAudit({ resource: "provider-credential", action: "credential.update", workspaceId: currentWorkspaceId(), result: "success" })
    }
    // The memory backend applies its public metadata through upsertProviderApiKey,
    // which already advances the routing revision. SQLite updates both records
    // in one transaction and needs this explicit invalidation once.
    if (!isMemoryBackend()) invalidateRoutingCaches()
    return applied
  })
}

/** Remove a Codex account together with its session material. */
export async function deleteCodexCredential(providerId: string, credentialId: string): Promise<void> {
  const account = await getProviderApiKey(providerId, credentialId)
  if (!account) return
  if (account.credentialKind !== "codex-oauth") throw new Error("Only Codex OAuth credentials can be removed through the Codex credential API.")
  await deleteProviderApiKey(providerId, credentialId)
}
