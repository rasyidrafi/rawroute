import { authenticateProxyKey } from "@/lib/auth"
import { catalogLiteLlmModelInfo } from "@/lib/catalog"
import { jsonError } from "@/lib/http"
import { readCatalogData } from "@/lib/store"
import { runInWorkspace } from "@/lib/workspace-context"

export async function GET(request: Request) {
  const authenticated = await authenticateProxyKey(request)
  if (!authenticated) return jsonError("Invalid gateway API key.", 401)
  return runInWorkspace(authenticated.workspace, async () => {
    const data = await readCatalogData()
    return Response.json({
      data: catalogLiteLlmModelInfo(
        data.providers,
        data.models,
        data.aliases,
      ),
    }, { headers: { "cache-control": "private, no-store" } })
  })
}
