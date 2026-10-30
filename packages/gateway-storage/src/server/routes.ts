import { declareRoute } from "@rawroute/platform/contracts/http"
import { jsonError } from "@rawroute/observability/contracts/http"
import { storageDashboard, saveStorageConnection, attachStorageBucket, createStorageKey, revokeStorageKey, revealStorageKey, setStorageCapabilities, deleteStorageConnection, updateStorageKeyPolicy } from "./repository"
import { detachStorageBucket, probeStorageBucket, resolveStorageMultipart } from "./service"
import { storageEnabled } from "./config"
import type { StorageAction, CapabilityStatus } from "../contracts"

async function GET_STATUS() {
  return Response.json({ state: storageEnabled() ? "available" : "disabled" }, { headers: { "cache-control": "no-store" } })
}
async function GET() { return Response.json(await storageDashboard(), { headers: { "cache-control": "no-store" } }) }
async function POST(request: Request) {
  if (Number(request.headers.get("content-length")) > 64 * 1024) return jsonError("Storage management request is too large.", 413)
  const reader = request.body?.getReader()
  let text = ""
  let bytes = 0
  const decoder = new TextDecoder()
  try {
    if (reader) while (true) {
      const result = await reader.read()
      if (result.done) { text += decoder.decode(); break }
      bytes += result.value.byteLength
      if (bytes > 64 * 1024) { await reader.cancel(); return jsonError("Storage management request is too large.", 413) }
      text += decoder.decode(result.value, { stream: true })
    }
  } finally { reader?.releaseLock() }
  try {
    const input = JSON.parse(text) as Record<string, unknown>
    const string = (name: string) => { if (typeof input[name] !== "string") throw new Error("Missing storage field."); return input[name] as string }
    let value: unknown
    switch (input.action) {
      case "save-connection": value = await saveStorageConnection({ id: typeof input.id === "string" ? input.id : undefined, name: string("name"), endpoint: string("endpoint"), region: string("region"), accessKeyId: string("accessKeyId"), secretAccessKey: string("secretAccessKey") }); break
      case "capabilities": {
        if (!input.statuses || typeof input.statuses !== "object" || Array.isArray(input.statuses)) throw new Error("Capability statuses are required.")
        value = await setStorageCapabilities(string("id"), Number(input.revision), input.statuses as Partial<Record<StorageAction, CapabilityStatus>>, input.ranges as CapabilityStatus | undefined, input.exactKeys as CapabilityStatus | undefined); break
      }
      case "attach-bucket": value = await attachStorageBucket({ connectionId: string("connectionId"), name: string("name"), upstreamBucket: string("upstreamBucket") }); break
      case "create-key": value = await createStorageKey({ name: string("name"), bucketIds: input.bucketIds as string[], actions: input.actions as StorageAction[] }); break
      case "revoke-key": await revokeStorageKey(string("id")); break
      case "update-key-policy": await updateStorageKeyPolicy(string("id"), { bucketIds: input.bucketIds as string[], actions: input.actions as StorageAction[] }); break
      case "reveal-key": value = await revealStorageKey(string("id")); break
      case "detach-bucket": await detachStorageBucket(string("id")); break
      case "delete-connection": await deleteStorageConnection(string("id")); break
      case "probe-bucket": value = await probeStorageBucket(string("id")); break
      case "cleanup-multipart": value = await resolveStorageMultipart(string("id"), { remoteId: typeof input.remoteId === "string" ? input.remoteId : undefined, confirmedAbsent: input.confirmedAbsent === true }); break
      default: return jsonError("Unknown Storage management operation.", 400)
    }
    return Response.json({ ok: true, value }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    // Domain validation strings are static. Do not echo parser/SQLite/SDK errors.
    const message = error instanceof Error && /^(Storage|Invalid|Missing|Select|Bucket|Logical|Finish|Detach|Connection|A name|Multipart|Key is|Capability)/.test(error.message) && !error.message.includes("SQL") ? error.message : "Storage operation failed. Check configuration and recovery status."
    return jsonError(message, 400)
  }
}
export const storageServerRoutes = { id: "storage", routes: [
  declareRoute({ GET: GET_STATUS }, "session", "/api/admin/storage/status"),
  declareRoute({ GET, POST }, "workspace", "/api/admin/storage", { idleTimeout: 0, idleTimeoutMethods: ["POST"] }),
] }
