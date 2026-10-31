import type { DocumentData } from "@rawroute/platform/server/database"
import type { AuditInput, AuditResource } from "@rawroute/platform/server/audit"
import { collectionPrefix } from "@rawroute/platform/server/storage-config"

/** Concrete AI-owned security mutation catalog; no document values are copied. */
export function aiDocumentAudit(collection: string, before: DocumentData | undefined, after: DocumentData | undefined): AuditInput | undefined {
  const parts = collection.split("/")
  let resource: AuditResource | undefined
  let workspaceId: string | undefined
  if (parts[0] === `${collectionPrefix()}_workspaces` && parts.length >= 3) {
    workspaceId = parts[1]
    const name = parts[parts.length - 1]
    resource = name === "apiKeys" ? parts.length === 3 ? "gateway-key" : "provider-credential"
      : name === "codexCredentials" ? "provider-credential"
      : name === "providers" ? "provider" : name === "models" ? "model" : name === "aliases" ? "alias" : name === "combos" ? "combo"
      : name === "budgets" || name === "budgetSettings" || name === "budgetWindows" || name === "budgetBypassSessions" ? "budget"
      : name === "modelPricingGroups" || name === "modelPricingVersions" ? "pricing" : undefined
  } else if (collection === `${collectionPrefix()}_model_shares`) {
    resource = "model-sharing"
    const value = after || before
    workspaceId = typeof value?.ownerWorkspaceId === "string" ? value.ownerWorkspaceId : undefined
  }
  if (!resource) return undefined
  const credential = resource === "gateway-key" || resource === "provider-credential"
  return { action: credential ? after ? before ? "credential.update" : "credential.create" : "credential.revoke" : after ? "config.update" : "config.delete", resource, workspaceId, result: "success" }
}
