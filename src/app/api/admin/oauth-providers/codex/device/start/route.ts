import { requireAdmin } from "@/lib/auth"
import { requestCodexDeviceCode } from "@/lib/codex"
import { jsonError } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  try { await requireAdmin() } catch { return jsonError("Unauthorized", 401) }
  try {
    return Response.json(await requestCodexDeviceCode())
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to start Codex device login.", 502)
  }
}

