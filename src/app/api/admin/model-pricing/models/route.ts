import { requireAdmin } from "@/lib/auth"
import { listCliProxyModels } from "@/lib/cliproxy-catalog"
import { listModels } from "@/lib/store"
import { jsonError } from "@/lib/http"


export async function GET() {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const [models, cliProxyModels] = await Promise.all([listModels(), listCliProxyModels()])
  return Response.json({ models: [...models, ...cliProxyModels.filter((candidate) => !models.some((model) => model.gatewayModelId === candidate.gatewayModelId))] })
}
