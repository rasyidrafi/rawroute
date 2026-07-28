import { validateProxyKey } from "@/lib/auth"
import { catalogModels } from "@/lib/catalog"
import { jsonError } from "@/lib/http"
import { readData } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  if (!(await validateProxyKey(request))) return jsonError("Invalid gateway API key.", 401)
  const data = await readData()
  return Response.json({
    object: "list",
    data: catalogModels(data.providers, data.models),
  })
}
