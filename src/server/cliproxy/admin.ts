import { createHash } from "node:crypto"
import { z } from "zod"
import { cliproxyManagement, cliproxyManagementJson } from "@/lib/cliproxy/management"
import { mappedWorkspaceForFile } from "@/lib/codex/cliproxy"
import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { managementRequest, boundedObject } from "./request"
import { withManagementMutation } from "./mutations"
import { cliproxySecret } from "./connection"
import { redact } from "./redaction"
import { hasManagedAuthPrefix } from "./auth-ownership"

export function globalManagement(request: Request, mutate: boolean, action: () => Promise<Response>) {
  return managementRequest(request, mutate, () => mutate ? withManagementMutation(action) : action())
}

function keyId(value: string) { return createHash("sha256").update(value).digest("hex").slice(0, 20) }
async function keys() {
  const { response, data } = await cliproxyManagementJson<{ "api-keys"?: unknown }>("/v0/management/api-keys")
  if (!response.ok || !Array.isArray(data?.["api-keys"])) throw new Error("CLIProxy API keys are unavailable.")
  return data["api-keys"].filter((key): key is string => typeof key === "string")
}
export function getKeys(request: Request) { return globalManagement(request, false, async () => {
  const managed = cliproxySecret("apiKey")
  return Response.json({ apiKeys: (await keys()).map(key => ({ id: keyId(key), value: key.length < 8 ? "••••••••" : `••••${key.slice(-4)}`, masked: true, managedTransport: key === managed })) })
}) }
export function putKeys(request: Request) { return globalManagement(request, true, async () => {
  const schema = z.union([z.strictObject({ add: z.string().trim().min(1).max(512) }), z.strictObject({ apiKeys: z.array(z.string().trim().min(1).max(512)).max(100) })])
  const parsed = schema.safeParse(await boundedObject(request).catch(() => null))
  if (!parsed.success) return jsonError("Provide an API key or replacement list.", 400)
  const managed = cliproxySecret("apiKey")
  if (!managed) return jsonError("Configure the RawRoute transport key before editing CLIProxy keys.", 409)
  const next = "add" in parsed.data ? [...await keys(), parsed.data.add] : parsed.data.apiKeys
  return saveKeys([...new Set([...next, managed])])
}) }
async function saveKeys(next: string[]) {
  const response = await cliproxyManagement("/v0/management/api-keys", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) })
  if (!response.ok) return jsonError("CLIProxy keys could not be saved.", response.status)
  recordLog("admin.cliproxy.keys.updated", { count: next.length })
  return Response.json({ ok: true })
}
export function deleteKey(request: Request, params: { keyId: string }) { return globalManagement(request, true, async () => {
  const current = await keys()
  const target = current.find(key => keyId(key) === params.keyId)
  if (!target) return jsonError("Key not found.", 404)
  const managed = cliproxySecret("apiKey")
  if (!managed || target === managed) return jsonError("The RawRoute transport key cannot be revoked.", 409)
  return saveKeys([...new Set([...current.filter(key => key !== target), managed])])
}) }

async function authFiles() {
  const { response, data } = await cliproxyManagementJson<{ files?: Array<Record<string, unknown>> }>("/v0/management/auth-files")
  if (!response.ok || !Array.isArray(data?.files)) throw new Error("CLIProxy auth files are unavailable.")
  return data.files
}
async function owner(file: Record<string, unknown>) {
  const workspaceId = typeof file.name === "string" ? await mappedWorkspaceForFile(file.name, "") : undefined
  return { workspaceId: workspaceId ?? null, managed: Boolean(workspaceId || hasManagedAuthPrefix(file.name) || typeof file.prefix === "string" && file.prefix.startsWith("rr-codex-")) }
}
export function getAuthFiles(request: Request) { return globalManagement(request, false, async () => {
  const files = await Promise.all((await authFiles()).map(async file => ({
    ...Object.fromEntries(["name", "type", "email", "status", "disabled", "unavailable", "prefix"].map(key => [key, file[key]])), ...await owner(file),
  })))
  return Response.json({ files: redact(files) })
}) }
export function mutateAuthFile(request: Request) { return globalManagement(request, true, async () => {
  const parsed = z.strictObject({ name: z.string().min(1).max(512).regex(/^[^/\\\r\n\0]+$/), disabled: z.boolean().optional() }).safeParse(request.method === "DELETE" ? { name: new URL(request.url).searchParams.get("name") } : await boundedObject(request).catch(() => null))
  if (!parsed.success || request.method === "PATCH" && parsed.data.disabled === undefined) return jsonError("Provide an auth-file name and valid status.", 400)
  const file = (await authFiles()).find(file => file.name === parsed.data.name)
  if (!file) return jsonError("Auth file not found.", 404)
  if ((await owner(file)).managed) return jsonError("Manage this account from its owning workspace.", 409)
  const deleting = request.method === "DELETE"
  const response = await cliproxyManagement(deleting ? `/v0/management/auth-files?name=${encodeURIComponent(parsed.data.name)}` : "/v0/management/auth-files/status", {
    method: deleting ? "DELETE" : "PATCH", ...(!deleting ? { headers: { "content-type": "application/json" }, body: JSON.stringify(parsed.data) } : {}),
  })
  if (!response.ok) return jsonError("Auth file could not be changed.", response.status)
  recordLog(deleting ? "admin.cliproxy.authentication.record.deleted" : "admin.cliproxy.authentication.record.updated")
  return Response.json({ ok: true })
}) }

export function getLogs(request: Request) { return globalManagement(request, false, async () => {
  const query = new URL(request.url).searchParams
  const allowed = new URLSearchParams()
  for (const key of ["after", "limit"]) { const value = query.get(key); if (value && /^\d{1,16}$/.test(value)) allowed.set(key, value) }
  const { response, data } = await cliproxyManagementJson(`/v0/management/logs?${allowed}`)
  if (!response.ok) return jsonError("CLIProxy logs are unavailable. Enable file logging in Settings.", response.status)
  return Response.json(redact(data))
}) }
export function clearLogs(request: Request) { return globalManagement(request, true, async () => {
  const response = await cliproxyManagement("/v0/management/logs", { method: "DELETE" })
  if (!response.ok) return jsonError("CLIProxy logs could not be cleared.", response.status)
  recordLog("admin.cliproxy.logs.cleared")
  return Response.json({ ok: true })
}) }
