import { createHash } from "node:crypto"

type Document = { path: string; data: Record<string, unknown> }
type AuthFile = { name: string; disabled: boolean; authIndex?: string; accountId?: string; email?: string; planType?: string }

/** Offline, one-time conversion. No request handler imports this module. */
export function convertDocument(document: Document, files: AuthFile[]): Document {
  const data = structuredClone(document.data)
  if (document.path.endsWith("_system/meta") && data.admin && typeof data.admin === "object") {
    delete (data.admin as Record<string, unknown>).username
  }
  if (/\/combos\/[^/]+$/.test(document.path)) {
    if (!Array.isArray(data.members)) {
      if (!Array.isArray(data.memberModelIds) || data.memberModelIds.some(value => typeof value !== "string")) throw new Error(`Invalid combo document: ${document.path}`)
      data.members = data.memberModelIds.map(modelId => ({ modelId, reasoning: { mode: "inherit" } }))
    }
    delete data.memberModelIds
  }
  if (/\/models\/[^/]+$/.test(document.path) && data.source === "builtin") {
    data.source = "discovered"
    data.discovery = { accountIds: [], stale: true }
  }
  if (/\/providers\/[^/]+\/apiKeys\/[^/]+$/.test(document.path)) {
    if (data.credentialKind === "codex-oauth") {
      const workspaceId = document.path.split("/")[1]!
      const digest = createHash("sha1").update(`rawroute:codex:${workspaceId}`).digest("hex").slice(0, 16)
      const identity = String(data.accountId || document.path.split("/").at(-1)).trim().replace(/[^A-Za-z0-9._-]+/g, "-")
      const name = data.cliProxyAuthFile || `codex-rawroute-rr-codex-${digest}-${identity}.json`
      const file = files.find(entry => entry.name === name)
      if (!file) throw new Error(`Unmapped Codex account at ${document.path}. Reconnect/export this account before conversion; no changes were applied.`)
      Object.assign(data, { credentialKind: "codex-cli-proxy", cliProxyAuthFile: file.name, enabled: !file.disabled })
      for (const key of ["accountId", "email", "planType"] as const) if (file[key]) data[key] = file[key]
      if (file.authIndex) data.cliProxyAuthIndex = file.authIndex
    }
    if (data.credentialKind === "codex-cli-proxy") {
      data.key = ""
      for (const key of ["refreshToken", "idToken", "rpmLimit", "maxConcurrency"]) delete data[key]
    }
  }
  return { path: document.path, data }
}
