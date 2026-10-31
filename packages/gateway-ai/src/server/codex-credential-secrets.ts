import { getDatabase, type Transaction } from "@rawroute/platform/server/database"
import { collectionPrefix, isMemoryBackend } from "@rawroute/platform/server/storage-config"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"

import { aiLocalDatabase } from "./local-db"
import { assertCodexCredentialSchema } from "./codex-credential-schema"

/**
 * Server-only Codex OAuth session material. The token fields are secrets: they
 * live exclusively in this store and never appear in browser contracts, audit
 * metadata, logs or error messages. The companion public account record (the
 * provider-scoped API key document) carries identity and expiry metadata only.
 */
export interface CodexCredentialSecrets {
  accessToken: string
  refreshToken?: string
  idToken?: string
  /** ISO timestamp when the access token stops being accepted upstream. */
  expiresAt?: string
  lastRefresh?: string
  /**
   * Monotonic write guard: a refresh applies only against the version it read,
   * so a deleted credential can never be resurrected by a stale writer.
   */
  version: number
}

export type CodexCredentialSecretsInput = Omit<CodexCredentialSecrets, "version">

interface StoredCodexCredentialSecrets extends CodexCredentialSecrets {
  accountId: string
}

export class CodexCredentialMissingError extends Error {
  constructor(message = "Codex credential not found.") {
    super(message)
    this.name = "CodexCredentialMissingError"
  }
}

export class CodexCredentialConflictError extends Error {
  constructor(message = "Codex credential changed before the update could be applied.") {
    super(message)
    this.name = "CodexCredentialConflictError"
  }
}

declare global { var __rawrouteCodexCredentials: Map<string, Map<string, StoredCodexCredentialSecrets>> | undefined }

const memorySecrets = () => globalThis.__rawrouteCodexCredentials ||= new Map<string, Map<string, StoredCodexCredentialSecrets>>()

function workspaceMemorySecrets(create = false) {
  const workspaceId = currentWorkspaceId()
  const existing = memorySecrets().get(workspaceId)
  if (existing) return existing
  if (!create) return undefined
  const slot = new Map<string, StoredCodexCredentialSecrets>()
  memorySecrets().set(workspaceId, slot)
  return slot
}

function codexCredentialsCollection() {
  // Workspace-rooted mirror of the provider credential store path; routing and
  // workspace deletion treat it as an owned workspace subtree.
  return aiLocalDatabase().collection(`${collectionPrefix()}_workspaces`).doc(currentWorkspaceId()).collection("codexCredentials")
}

export function codexCredentialSecretsRef(credentialId: string) {
  return codexCredentialsCollection().doc(credentialId)
}

function storedSecrets(value: unknown) {
  const candidate = value as Partial<StoredCodexCredentialSecrets> | undefined
  return candidate && typeof candidate.accessToken === "string" && typeof candidate.version === "number" ? candidate as StoredCodexCredentialSecrets : undefined
}

/** Read the current session material for a credential in the active workspace. */
export async function readCodexCredentialSecrets(credentialId: string): Promise<CodexCredentialSecrets | undefined> {
  if (isMemoryBackend()) {
    const secrets = workspaceMemorySecrets()?.get(credentialId)
    return secrets ? { ...secrets } : undefined
  }
  // The read forces schema preparation first; the guard then refuses to serve
  // session material from a database that was never migrated.
  const snapshot = await codexCredentialSecretsRef(credentialId).get()
  assertCodexCredentialSchema(getDatabase())
  const secrets = snapshot.exists ? storedSecrets(snapshot.data()) : undefined
  return secrets ? { ...secrets } : undefined
}

/** Create or replace session material inside an owning transaction (register). */
export async function stageCodexCredentialSecrets(transaction: Transaction, credentialId: string, accountId: string, secrets: CodexCredentialSecretsInput): Promise<void> {
  const snapshot = await transaction.get(codexCredentialSecretsRef(credentialId))
  const previous = snapshot.exists ? storedSecrets(snapshot.data()) : undefined
  transaction.set(codexCredentialSecretsRef(credentialId), { ...secrets, accountId, version: (previous?.version ?? 0) + 1 })
}

/** Remove session material inside an owning transaction (credential deletion). */
export function stageCodexCredentialSecretsRemoval(transaction: Transaction, credentialId: string): void {
  transaction.delete(codexCredentialSecretsRef(credentialId))
}

/**
 * Race-safe compare-and-swap apply: succeeds only when the stored session still
 * carries `expectedVersion`, so concurrent refreshes and a deletion between the
 * read and the write both fail instead of overwriting or resurrecting state.
 * An `applyCompanion` runs inside the same transaction after the version
 * checks pass; throwing there rolls the session write back with it.
 */
export async function applyCodexCredentialSecrets(
  credentialId: string,
  expectedVersion: number,
  secrets: CodexCredentialSecretsInput,
  applyCompanion?: (transaction: Transaction) => Promise<void>,
): Promise<CodexCredentialSecrets> {
  if (isMemoryBackend()) {
    const stored = workspaceMemorySecrets()?.get(credentialId)
    if (!stored) throw new CodexCredentialMissingError()
    if (stored.version !== expectedVersion) throw new CodexCredentialConflictError()
    const next: StoredCodexCredentialSecrets = { ...secrets, accountId: stored.accountId, version: stored.version + 1 }
    workspaceMemorySecrets(true)!.set(credentialId, next)
    return { ...next }
  }
  return aiLocalDatabase().runTransaction(async (transaction) => {
    assertCodexCredentialSchema(getDatabase())
    const snapshot = await transaction.get(codexCredentialSecretsRef(credentialId))
    const stored = snapshot.exists ? storedSecrets(snapshot.data()) : undefined
    if (!stored) throw new CodexCredentialMissingError()
    if (stored.version !== expectedVersion) throw new CodexCredentialConflictError()
    const next: StoredCodexCredentialSecrets = { ...secrets, accountId: stored.accountId, version: stored.version + 1 }
    if (applyCompanion) await applyCompanion(transaction)
    transaction.set(codexCredentialSecretsRef(credentialId), next)
    return { ...next }
  })
}

/** Memory-backend session material for a credential (used by register). */
export function setMemoryCodexCredentialSecrets(credentialId: string, accountId: string, secrets: CodexCredentialSecretsInput): void {
  const slot = workspaceMemorySecrets(true)!
  const previous = slot.get(credentialId)
  slot.set(credentialId, { ...secrets, accountId, version: (previous?.version ?? 0) + 1 })
}

/** Memory-backend removal alongside a public credential record deletion. */
export function deleteMemoryCodexCredentialSecrets(credentialId: string): void {
  workspaceMemorySecrets()?.delete(credentialId)
}

/** Memory-backend workspace teardown. */
export function deleteWorkspaceMemoryCodexCredentials(workspaceId: string): void {
  memorySecrets().delete(workspaceId)
}

export function resetCodexCredentialMemory(): void {
  globalThis.__rawrouteCodexCredentials = undefined
}
