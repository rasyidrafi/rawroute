import { serverEvents, type ServerEvent } from "@/lib/logging/events"
import type { LogDetails, LogLevel } from "@/lib/logging/types"
import { requestContext } from "@/server/request-context"
import { logs, type LogAdmission } from "./store"

// String metadata is limited to operational identifiers and closed-format values.
// Never accept arbitrary errors, names, URLs, bodies, headers or credential values.
const identifierFields = new Set(["providerId", "modelId", "memberModelId", "accountId", "apiKeyId", "groupId", "versionId", "comboId", "aliasId", "workspaceId", "redeemRequestId"])
const labelFields = new Set(["model", "upstreamModel", "protocol", "upstreamProtocol", "errorCode", "reasoningEffort", "action", "setting", "method", "route", "page", "endedAt", "source"])
const numericFields = new Set(["exitCode", "attempt", "restartAttempts", "status", "durationMs", "ttftMs", "inputTokens", "outputTokens", "cachedTokens", "messageCount", "toolCount", "count", "modelCount", "recipientCount", "added", "removed", "updated", "retryAfter", "providers", "keys", "models", "projectedCredentials", "projectedModels"])
const booleanFields = new Set(["succeeded", "enabled", "autoDeactivateAtWindowEnd", "terminalEvent", "usageKnown", "reordered", "streaming", "promptCacheKey", "supportPromptCacheKey"])

export function safeDetails(input: Record<string, unknown>): LogDetails {
  const result: LogDetails = {}
  for (const [key, value] of Object.entries(input).slice(0, 32)) {
    if (numericFields.has(key) && typeof value === "number" && Number.isFinite(value)) result[key] = value
    if (booleanFields.has(key) && typeof value === "boolean") result[key] = value
    if ((identifierFields.has(key) || labelFields.has(key)) && typeof value === "string" && value.length <= 160
      && /^[a-zA-Z0-9_.:/{} -]+$/.test(value) && !/bearer |sk-|password|secret|token=/i.test(value)) result[key] = value
  }
  return result
}

export function recordLog(event: ServerEvent, details: Record<string, unknown> = {}, options: { level?: LogLevel; scope?: LogAdmission } = {}) {
  const context = requestContext()
  const definition = serverEvents[event]
  return logs.record({
    ...definition, event, level: options.level ?? "info", origin: "server", requestId: context.requestId,
    details: safeDetails(details),
  }, options.scope ?? context.logScope)
}
