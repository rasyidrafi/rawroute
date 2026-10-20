import { AsyncLocalStorage } from "node:async_hooks"

export type AuditActor = "administrator" | "system" | "gateway" | "anonymous"
type AuditIdentity = { actor: AuditActor; actorId?: string; correlationId: string }
declare global { var __rawrouteAuditContext: AsyncLocalStorage<AuditIdentity> | undefined }
const context = globalThis.__rawrouteAuditContext ||= new AsyncLocalStorage<AuditIdentity>()
export function auditIdentity() { return context.getStore() }
export function runWithAuditIdentity<T>(actor: AuditActor, correlationId: string, callback: () => T): T {
  return context.run({ actor, correlationId }, callback)
}
/** credentialId is an opaque verified record ID, never the supplied key value. */
export function runWithGatewayAuditIdentity<T>(credentialId: string, callback: () => T): T {
  return context.run({ actor: "gateway", actorId: credentialId, correlationId: context.getStore()?.correlationId || crypto.randomUUID() }, callback)
}
