import { requireAdmin } from "@/lib/auth"
import { requestCodexDeviceCode } from "@/lib/codex"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"


export async function POST() {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  try {
    const result = await requestCodexDeviceCode()
    writeLog("info", "admin", "Codex device login started")
    return Response.json(result)
  } catch (error) {
    writeLog("error", "admin", "Codex device login start failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to start Codex device login.", 502)
  }
}
