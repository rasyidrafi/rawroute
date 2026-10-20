import { authenticateProxyKey } from "../../../../auth"
import { catalogLiteLlmModelInfo } from "../../../../../contracts/catalog"
import { jsonError } from "@rawroute/observability/contracts/http"

import { readCatalogData } from "../../../../store"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"

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
