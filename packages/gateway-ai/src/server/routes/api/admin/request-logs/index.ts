import { listRequestLogs, loadDashboardModelLabels } from "../../../../analytics"
import { parseRequestLogQuery } from "../../../../request-logs"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"
import { jsonError } from "@rawroute/observability/contracts/http"

import { requestLogKeyLabel } from "../../../../../contracts/request-logs"
import { listAliases, listApiKeys, listDeletedApiKeyNames, listModels, listProviders } from "../../../../store"
import { listSharedModelsForRecipient } from "../../../../model-shares"

export async function GET(request: Request) {
  let query
  try { query = parseRequestLogQuery(new URL(request.url).searchParams, currentWorkspaceId()) }
  catch { return jsonError("Invalid request log range, filters or cursor.", 400) }
  try {
    const [page, modelNames, keys, deletedNames, providers, models, aliases, shared] = await Promise.all([listRequestLogs(query), loadDashboardModelLabels(), listApiKeys(), listDeletedApiKeyNames(currentWorkspaceId()), listProviders(), listModels(), listAliases(), listSharedModelsForRecipient()])
    const providerNames = new Map(providers.map(provider => [provider.id, provider.name]))
    const modelProviders = new Map<string, string | null>()
    for (const model of models) {
      const id = model.upstreamModel.trim()
      const provider = providerNames.get(model.providerId) ?? null
      modelProviders.set(id, modelProviders.has(id) && modelProviders.get(id) !== provider ? null : provider)
    }
    for (const model of models) modelProviders.set(model.gatewayModelId, providerNames.get(model.providerId) ?? null)
    for (const model of shared) modelProviders.set(model.qualifiedModelId, model.providerName)
    for (const alias of aliases) modelProviders.set(alias.alias, modelProviders.get(alias.targetModelId) ?? null)
    for (const event of page.events) {
      if (!event.providerId) continue
      const provider = providerNames.get(event.providerId)
      if (!provider) continue
      for (const id of [event.routing?.modelId, event.gatewayModelId]) if (id && !modelProviders.has(id)) modelProviders.set(id, provider)
    }
    const keyNames = new Map(keys.map(key => [key.id, key.name]))
    for (const [id, name] of deletedNames) if (!keyNames.has(id)) keyNames.set(id, name)
    const modelOptions = new Map(modelNames)
    const keyOptions = new Map(keyNames)
    if (query.key && !keyOptions.has(query.key)) keyOptions.set(query.key, keyNames.get(query.key) || requestLogKeyLabel({ gatewayKeyId: query.key }))
    // Include historical, alias and shared IDs seen on this bounded page, without scanning history.
    for (const event of page.events) if (!modelOptions.has(event.gatewayModelId)) modelOptions.set(event.gatewayModelId, event.gatewayModelId)
    for (const event of page.events) if (event.requestedModel && !modelOptions.has(event.requestedModel)) modelOptions.set(event.requestedModel, event.requestedModel)
    for (const event of page.events) {
      if (event.routing) modelOptions.set(event.routing.modelId, event.routing.modelName)
      if (!keyOptions.has(event.gatewayKeyId)) keyOptions.set(event.gatewayKeyId, requestLogKeyLabel(event))
    }
    return Response.json({ ...page, events: page.events.map(event => ({ ...event, keyName: keyNames.get(event.gatewayKeyId) || null, modelName: event.routing?.modelName || modelNames.get(event.gatewayModelId) || null })), models: [...modelOptions].map(([id, name]) => ({ id, name, provider: modelProviders.get(id) ?? null })), keys: [...keyOptions].map(([id, name]) => ({ id, name })) })
  } catch { return jsonError("Unable to load request logs.", 500) }
}
