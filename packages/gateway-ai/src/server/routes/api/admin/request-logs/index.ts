import { listRequestLogs, loadDashboardModelLabels } from "../../../../analytics"
import { parseRequestLogQuery } from "../../../../request-logs"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"
import { jsonError } from "@rawroute/observability/contracts/http"

import { requestLogKeyLabel, type RequestLogsPage } from "../../../../../contracts/request-logs"
import { listAliases, listApiKeys, listCombos, listDeletedApiKeyNames, listModels, listProviders } from "../../../../store"
import { listSharedModelsForRecipient } from "../../../../model-shares"

export async function GET(request: Request) {
  let query
  try { query = parseRequestLogQuery(new URL(request.url).searchParams, currentWorkspaceId()) }
  catch { return jsonError("Invalid request log range, filters or cursor.", 400) }
  try {
    const [modelNames, keys, deletedNames, providers, models, aliases, combos, shared] = await Promise.all([loadDashboardModelLabels(), listApiKeys(), listDeletedApiKeyNames(currentWorkspaceId()), listProviders(), listModels(), listAliases(), listCombos(), listSharedModelsForRecipient()])
    const providerNames = new Map(providers.map(provider => [provider.id, provider.name]))
    const options = new Map<string, RequestLogsPage["models"][number]>()
    const upstreamOwner = new Map<string, string | null>()
    for (const model of models) {
      const id = model.gatewayModelId
      options.set(id, { id, name: model.name, provider: providerNames.get(model.providerId) ?? null })
      const upstream = model.upstreamModel.trim()
      if (upstream) upstreamOwner.set(upstream, upstreamOwner.has(upstream) ? null : id)
    }
    for (const model of shared) options.set(model.qualifiedModelId, { id: model.qualifiedModelId, name: model.sourceModelName, provider: model.providerName })
    for (const { alias: id, name } of aliases) options.set(id, { id, name: name || id, provider: null, route: true })
    for (const { combo: id, name } of combos) options.set(id, { id, name: name || id, provider: null, route: true })
    const selected = models.find(model => model.gatewayModelId === query.model)
    const upstream = selected?.upstreamModel.trim()
    const page = await listRequestLogs({ ...query, upstream: upstream && upstreamOwner.get(upstream) === query.model && !options.has(upstream) ? upstream : undefined })
    const keyNames = new Map(keys.map(key => [key.id, key.name]))
    for (const [id, name] of deletedNames) if (!keyNames.has(id)) keyNames.set(id, name)
    const keyOptions = new Map(keyNames)
    if (query.key && !keyOptions.has(query.key)) keyOptions.set(query.key, keyNames.get(query.key) || requestLogKeyLabel({ gatewayKeyId: query.key }))
    // Include historical, alias and shared IDs seen on this bounded page, without scanning history.
    for (const event of page.events) {
      for (const id of [event.routing?.modelId, event.gatewayModelId, event.requestedModel]) {
        if (!id || options.has(id) || upstreamOwner.get(id)) continue
        options.set(id, { id, name: event.routing?.modelId === id ? event.routing.modelName : id, provider: null })
      }
      if (!keyOptions.has(event.gatewayKeyId)) keyOptions.set(event.gatewayKeyId, requestLogKeyLabel(event))
    }
    return Response.json({ ...page, events: page.events.map(event => ({ ...event, keyName: keyNames.get(event.gatewayKeyId) || null, modelName: event.routing?.modelName || modelNames.get(event.gatewayModelId) || null })), models: [...options.values()], keys: [...keyOptions].map(([id, name]) => ({ id, name })) })
  } catch { return jsonError("Unable to load request logs.", 500) }
}
