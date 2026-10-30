import { serverEvents } from "./events"
import type { LogDetails } from "@rawroute/observability/contracts/types"
import { normalizeRequestReasoningEffort, normalizeRequestToolCount } from "./request-log-metadata"
import { createRecorder } from "@rawroute/observability/server/recorder"

// String metadata is limited to operational identifiers and closed-format values.
// Never accept arbitrary errors, names, URLs, bodies, headers or credential values.
const identifierFields = new Set(["providerId", "modelId", "memberModelId", "accountId", "apiKeyId", "groupId", "versionId", "comboId", "aliasId", "workspaceId", "redeemRequestId"])
const labelFields = new Set(["model", "upstreamModel", "protocol", "upstreamProtocol", "errorCode", "action", "setting", "method", "route", "page", "endedAt", "source"])
const numericFields = new Set(["exitCode", "attempt", "restartAttempts", "status", "durationMs", "ttftMs", "inputTokens", "outputTokens", "cachedTokens", "messageCount", "toolCount", "count", "modelCount", "recipientCount", "added", "removed", "updated", "retryAfter", "providers", "keys", "models", "projectedCredentials", "projectedModels", "hourlyRows", "dailyRows", "rollupRows", "boundaryRows"])
const booleanFields = new Set(["succeeded", "enabled", "autoDeactivateAtWindowEnd", "terminalEvent", "usageKnown", "reordered", "streaming", "promptCacheKey", "supportPromptCacheKey", "expiryEnabled", "weeklyExhaustionEnabled"])

export function safeDetails(input: Record<string, unknown>): LogDetails {
  const result: LogDetails = {}
  for (const [key, value] of Object.entries(input).slice(0, 32)) {
    if (key === "reasoningEffort") {
      const effort = normalizeRequestReasoningEffort(value)
      if (effort) result.reasoningEffort = effort
      continue
    }
    if (key === "toolCount") {
      const toolCount = normalizeRequestToolCount(value)
      if (toolCount !== undefined) result.toolCount = toolCount
      continue
    }
    if (numericFields.has(key) && typeof value === "number" && Number.isFinite(value)) result[key] = value
    if (booleanFields.has(key) && typeof value === "boolean") result[key] = value
    if ((identifierFields.has(key) || labelFields.has(key)) && typeof value === "string" && value.length <= 160
      && /^[a-zA-Z0-9_.:/{} -]+$/.test(value) && !/bearer |sk-|password|secret|token=/i.test(value)) result[key] = value
  }
  return result
}

export const recordLog = createRecorder(serverEvents, safeDetails)
