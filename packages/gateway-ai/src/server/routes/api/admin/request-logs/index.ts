import { listRequestLogs, loadDashboardModelLabels } from "../../../../analytics"
import { parseRequestLogQuery } from "../../../../request-logs"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"
import { jsonError } from "@rawroute/observability/contracts/http"

import { listApiKeys } from "../../../../store"

export async function GET(request: Request) {
  let query
  try { query = parseRequestLogQuery(new URL(request.url).searchParams, currentWorkspaceId()) }
  catch { return jsonError("Invalid request log range, filters or cursor.", 400) }
  try {
    const [page, modelNames, keys] = await Promise.all([listRequestLogs(query), loadDashboardModelLabels(), listApiKeys()])
    const keyNames = new Map(keys.map(key => [key.id, key.name]))
    const modelOptions = new Map(modelNames)
    const keyOptions = new Map(keyNames)
    // Include historical, alias and shared IDs seen on this bounded page, without scanning history.
    for (const event of page.events) if (!modelOptions.has(event.gatewayModelId)) modelOptions.set(event.gatewayModelId, event.gatewayModelId)
    for (const event of page.events) if (!keyOptions.has(event.gatewayKeyId)) keyOptions.set(event.gatewayKeyId, `Unknown key (${event.gatewayKeyId.slice(0, 8)})`)
    return Response.json({ ...page, events: page.events.map(event => ({ ...event, keyName: keyNames.get(event.gatewayKeyId) || null, modelName: modelNames.get(event.gatewayModelId) || null })), models: [...modelOptions].map(([id, name]) => ({ id, name })), keys: [...keyOptions].map(([id, name]) => ({ id, name })) })
  } catch { return jsonError("Unable to load request logs.", 500) }
}
