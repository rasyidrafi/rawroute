import { refreshCodexModels } from "@/lib/codex/model-discovery"
import { getProvider } from "@/lib/store"
import { jsonError } from "@/lib/http"

export async function POST(_request: Request, params: { providerId: string }) {
  const { providerId } = params
  const provider = await getProvider(providerId)
  if (provider?.prefix !== "codex") return jsonError("Codex provider not found.", 404)
  return Response.json(await refreshCodexModels(true))
}
