import { auditIdentity, type AuditActor } from "@rawroute/observability/server/audit-context"
import type { Database } from "bun:sqlite"
import { getDatabase, getSqliteDatabase, type Transaction, withTransaction } from "./database"
import { collectionPrefix, isMemoryBackend } from "./storage-config"

export type AuditAction = "auth.login" | "auth.logout" | "auth.password" | "identity.update" | "workspace.create" | "workspace.rename" | "workspace.delete.request" | "workspace.delete.participant" | "workspace.delete.complete" | "workspace.delete.failure" | "credential.create" | "credential.update" | "credential.revoke" | "config.update" | "config.delete" | "cliproxy.lifecycle" | "oauth.remote" | "storage.remote" | "storage.secret.reveal"
export type AuditResource = "administrator" | "workspace" | "gateway-key" | "provider-credential" | "provider" | "model" | "alias" | "combo" | "model-sharing" | "routing" | "budget" | "pricing" | "cliproxy" | "oauth" | "storage-connection" | "storage-bucket" | "storage-key" | "storage-multipart" | "storage-object"
export interface AuditInput {
  action: AuditAction
  resource: AuditResource
  result: "success" | "failure" | "started"
  workspaceId?: string
}
export interface AuditEvent extends AuditInput { id: string; at: string; actor: AuditActor; actorId?: string; correlationId: string }
declare global { var __rawrouteMemoryAudit: AuditEvent[] | undefined }
const memory = () => globalThis.__rawrouteMemoryAudit ||= []
const collection = () => `${collectionPrefix()}_audit`

function event(input: AuditInput): AuditEvent {
  // Construct a closed shape: never spread caller objects, bodies, errors, names,
  // credential names/values or remote responses into the security trail.
  const identity = auditIdentity()
  return { id: crypto.randomUUID(), at: new Date().toISOString(), actor: identity?.actor || "system", ...(identity?.actorId ? { actorId: identity.actorId } : {}), correlationId: identity?.correlationId || crypto.randomUUID(), action: input.action, resource: input.resource, result: input.result, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) }
}

/** Used only while the shared SQLite transaction is held. Throws => rollback. */
export function appendAuditSqlite(database: Database, input: AuditInput) {
  const value = event(input)
  database.run("INSERT INTO rawroute_documents (path, collection_path, document_id, data) VALUES (?, ?, ?, ?)", [`${collection()}/${value.id}`, collection(), value.id, JSON.stringify(value)])
}

export function appendMemoryAudit(input: AuditInput) {
  if (!isMemoryBackend()) throw new Error("Memory audit requires the memory backend.")
  memory().push(event(input))
}

export function stageAudit(transaction: Transaction, input: AuditInput) {
  const value = event(input)
  transaction.create(getSqliteDatabase().collection(collection()).doc(value.id), value)
}

export async function appendAudit(input: AuditInput) {
  if (isMemoryBackend()) appendMemoryAudit(input)
  else await withTransaction(async () => { appendAuditSqlite(getDatabase(), input) })
}

/** Remote state cannot share a local transaction: durable intent precedes it. */
export async function auditRemoteOperation<T>(input: Omit<AuditInput, "result">, operation: () => Promise<T>, succeeded: (value: T) => boolean = value => !(value instanceof Response) || value.ok): Promise<T> {
  await appendAudit({ ...input, result: "started" })
  let value: T | undefined
  try {
    value = await operation()
    await appendAudit({ ...input, result: succeeded(value) ? "success" : "failure" })
    return value
  } catch (error) {
    if (value instanceof Response) await value.body?.cancel().catch(() => undefined)
    await appendAudit({ ...input, result: "failure" })
    throw error
  }
}

/** Narrow server-only query; audit has intentionally no clear/update API. */
export async function queryAudit(options: { workspaceId?: string; limit?: number } = {}): Promise<AuditEvent[]> {
  const limit = Math.max(1, Math.min(options.limit || 100, 1000))
  if (isMemoryBackend()) return structuredClone(memory().filter(value => !options.workspaceId || value.workspaceId === options.workspaceId).slice(-limit).reverse())
  const ref = getSqliteDatabase().collection(collection())
  const query = options.workspaceId ? ref.where("workspaceId", "==", options.workspaceId) : ref
  const snapshot = await query.orderBy("at", "desc").limit(limit).get()
  return snapshot.docs.map(doc => doc.data() as unknown as AuditEvent)
}
