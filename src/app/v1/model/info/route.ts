import { authenticateProxyKey } from "@/lib/auth"
import { catalogLiteLlmModelInfo } from "@/lib/catalog"
import { listCliProxyCatalog } from "@/lib/cliproxy-catalog"
import { jsonError } from "@/lib/http"
import { readCatalogData } from "@/lib/store"
import { runInWorkspace } from "@/lib/workspace-context"

export async function GET(request: Request) {
  const authenticated = await authenticateProxyKey(request)
  if (!authenticated) return jsonError("Invalid gateway API key.", 401)
  return runInWorkspace(authenticated.workspace, async () => {
    const [data, cliProxyCatalog] = await Promise.all([readCatalogData(), listCliProxyCatalog()])
    return Response.json({
      data: catalogLiteLlmModelInfo(
        [...data.providers, ...cliProxyCatalog.providers],
        [...data.models, ...cliProxyCatalog.models],
        data.aliases,
      ),
    }, { headers: { "cache-control": "private, no-store" } })
  })
}
