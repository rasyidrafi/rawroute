import { validateProxyKey } from "@/lib/auth"
import { catalogModels } from "@/lib/catalog"
import { jsonError } from "@/lib/http"
import { readCatalogData } from "@/lib/store"


export async function GET(request: Request) {
  if (!(await validateProxyKey(request))) return jsonError("Invalid gateway API key.", 401)
  const data = await readCatalogData()
  return Response.json({
    object: "list",
    data: catalogModels(data.providers, data.models, data.aliases),
  }, { headers: { "cache-control": "private, max-age=5, stale-while-revalidate=30" } })
}
