import { getPublicKeyUsageDetail, listRequestLogs, loadDashboardModelLabels } from "../../../../../../analytics"
import { jsonError } from "@rawroute/observability/contracts/http"

import { parseRequestLogQuery } from "../../../../../../request-logs"
import { normalizeRequestLogMetadata } from "../../../../../../request-log-metadata"
import { currentWorkspaceId, runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { DEFAULT_WORKSPACE_ID } from "@rawroute/platform/contracts/workspace"
import { getPublicWorkspace } from "@rawroute/platform/server/runtime"

export async function GET(request: Request, { keyId }: { keyId: string }) {
  if (!/^[a-f0-9]{64}$/.test(keyId)) return jsonError("Usage detail not found.", 404)

  const params = new URL(request.url).searchParams
  if ([...params.keys()].some(key => key !== "workspace") || params.getAll("workspace").length > 1) return jsonError("Invalid workspace.", 400)
  const workspaceId = params.get("workspace") || DEFAULT_WORKSPACE_ID
  const workspace = await getPublicWorkspace(workspaceId)
  if (!workspace || workspace.status !== "active") return jsonError("Workspace not found.", 404)

  try {
    const detail = await runInWorkspace(workspace, async () => {
      const result = await getPublicKeyUsageDetail(keyId)
      if (!result) return undefined
      const requestQuery = parseRequestLogQuery(new URLSearchParams({
        from: result.payload.range.from,
        to: result.payload.range.to,
        status: "all",
        model: "",
        key: result.keyId,
      }), currentWorkspaceId())
      const [recent, modelLabels] = await Promise.all([listRequestLogs(requestQuery), loadDashboardModelLabels()])
      const keyName = result.payload.keys[0]?.label || null
      return {
        usage: result.payload,
        recent: {
          events: recent.events.slice(0, 5).map(event => ({
            id: event.id,
            gatewayModelId: event.gatewayModelId,
            status: event.status,
            usageAvailable: event.usageAvailable,
            usageCompleteness: event.usageCompleteness,
            totalTokens: event.totalTokens,
            inputTokens: event.inputTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheCreationTokens: event.cacheCreationTokens,
            outputTokens: event.outputTokens,
            pricingConfidence: event.pricingConfidence,
            costMicros: event.costMicros,
            durationMs: event.durationMs,
            completedAt: event.completedAt,
            ...normalizeRequestLogMetadata(event),
            keyName,
            modelName: modelLabels.get(event.gatewayModelId) || null,
          })),
        },
      }
    })
    if (!detail) return jsonError("Usage detail not found.", 404)
    return Response.json(detail, { headers: { "cache-control": "public, max-age=30, s-maxage=30, stale-while-revalidate=120" } })
  } catch {
    return jsonError("Unable to load public usage detail.", 503)
  }
}
