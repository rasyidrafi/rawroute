import { requireAdmin } from "@/lib/auth"
import { refreshCodexModels } from "@/lib/codex-model-discovery"
import { getProvider } from "@/lib/store"
import { jsonError } from "@/lib/http"

export async function POST(_request: Request, context: { params: Promise<{ providerId: string }> }) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const { providerId } = await context.params
  const provider = await getProvider(providerId)
  if (provider?.prefix !== "codex") return jsonError("Codex provider not found.", 404)
  return Response.json(await refreshCodexModels(true))
}
