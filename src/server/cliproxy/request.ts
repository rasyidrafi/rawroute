import { readMeta } from "@/server/store"
import { assertLogOrigin } from "@/server/logging/http"
import { jsonError } from "@/lib/http"

export async function managementRequest(request: Request, mutate: boolean, action: () => Promise<Response>) {
  if ((await readMeta()).admin.mustChangePassword) return jsonError("Change the initial administrator password first.", 403)
  if (mutate) { const rejected = assertLogOrigin(request); if (rejected) return rejected }
  try { return await action() }
  catch (error) {
    const code = (error as { status?: unknown })?.status
    const message = error instanceof Error ? error.message : "CLIProxy operation failed."
    if (code === 409) return jsonError(message, 409)
    return jsonError("CLIProxy operation failed. Check service status and System Logs.", 502)
  }
}

export async function boundedObject(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("JSON is required.")
  if (Number(request.headers.get("content-length")) > 8192) throw new Error("Request body is too large.")
  const reader = request.body?.getReader()
  if (!reader) throw new Error("Request body is required.")
  let text = ""
  let bytes = 0
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 8192) { await reader.cancel(); throw new Error("Request body is too large.") }
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } finally { reader.releaseLock() }
}
