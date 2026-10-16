import { listRequestLogs, loadDashboardModelLabels } from "@/lib/analytics"
import { parseRequestLogQuery } from "@/lib/request-logs"
import { currentWorkspaceId } from "@/lib/workspace/context"
import { jsonError } from "@/lib/http"
import { listApiKeys } from "@/server/store"

export async function GET(request: Request) {
  let query
  try { query = parseRequestLogQuery(new URL(request.url).searchParams, currentWorkspaceId()) }
  catch { return jsonError("Invalid request log range, filters or cursor.", 400) }
  try {
    const [page, modelNames, keys] = await Promise.all([listRequestLogs(query), loadDashboardModelLabels(), listApiKeys()])
    const keyNames = new Map(keys.map(key => [key.id, key.name]))
    const modelOptions = new Map(modelNames)
    // Include historical, alias and shared IDs seen on this bounded page, without scanning history.
    for (const event of page.events) if (!modelOptions.has(event.gatewayModelId)) modelOptions.set(event.gatewayModelId, event.gatewayModelId)
    return Response.json({ ...page, events: page.events.map(event => ({ ...event, keyName: keyNames.get(event.gatewayKeyId) || null, modelName: modelNames.get(event.gatewayModelId) || null })), models: [...modelOptions].map(([id, name]) => ({ id, name })) })
  } catch { return jsonError("Unable to load request logs.", 500) }
}
