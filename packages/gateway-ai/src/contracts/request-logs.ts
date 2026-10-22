import type { DashboardPayload, UsageEvent } from "./domain"

export type RequestLogsPage = { events: (UsageEvent & { keyName: string | null; modelName: string | null })[]; nextCursor: string | null; from: string; to: string; models: { id: string; name: string }[]; keys: { id: string; name: string }[] }
export type RequestLogDisplayEvent = Pick<UsageEvent, "routing" | "sharedUsage" | "id" | "requestId" | "requestedModel" | "attemptIndex" | "requestFinal" | "gatewayModelId" | "status" | "usageAvailable" | "usageCompleteness" | "totalTokens" | "inputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "outputTokens" | "pricingConfidence" | "costMicros" | "durationMs" | "completedAt" | "reasoningEffort" | "toolCount" | "requestedServiceTier" | "sentServiceTier" | "effectiveServiceTier" | "pricingServiceTier"> & { keyName: string | null; modelName: string | null; gatewayKeyId?: string; startedAt?: string }
export type PublicKeyUsageDetail = { usage: DashboardPayload; recent: { events: RequestLogDisplayEvent[] } }

type GroupableEvent = Pick<UsageEvent, "id" | "requestId" | "attemptIndex" | "completedAt"> & { gatewayKeyId?: string; sharedUsage?: UsageEvent["sharedUsage"] }

export function requestLogGroupId(event: GroupableEvent) {
  return JSON.stringify([event.sharedUsage?.role === "owner" ? event.id : event.requestId || event.id, event.gatewayKeyId || ""])
}

/** Owner copies are individual shared executions, not the consumer's fallback chain. */
export function requestLogComplete(event: Pick<UsageEvent, "requestFinal" | "sharedUsage">) {
  return event.sharedUsage?.role === "owner" || event.requestFinal !== false
}

export function requestLogKeyLabel(event: { keyName?: string | null; gatewayKeyId?: string; sharedUsage?: UsageEvent["sharedUsage"] }) {
  if (event.sharedUsage?.role === "owner") return `Shared usage · ${event.sharedUsage.peerWorkspaceName || event.sharedUsage.peerWorkspaceId}`
  return event.keyName || (event.gatewayKeyId ? `Unknown key (${event.gatewayKeyId.slice(0, 8)})` : "Unknown key")
}

/** Only consumer ingress correlation joins attempts. Historical attempts stay standalone. */
export function groupRequestLogEvents<T extends GroupableEvent>(events: T[]) {
  const groups = new Map<string, T[]>()
  for (const event of events) {
    const key = requestLogGroupId(event)
    const group = groups.get(key)
    if (group) group.push(event)
    else groups.set(key, [event])
  }
  return [...groups.values()].map(attempts => attempts.sort((a, b) => (a.attemptIndex ?? 0) - (b.attemptIndex ?? 0) || a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id)))
}
