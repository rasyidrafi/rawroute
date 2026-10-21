import type { DashboardPayload, UsageEvent } from "./domain"

export type RequestLogsPage = { events: (UsageEvent & { keyName: string | null; modelName: string | null })[]; nextCursor: string | null; from: string; to: string; models: { id: string; name: string }[]; keys: { id: string; name: string }[] }
export type RequestLogDisplayEvent = Pick<UsageEvent, "id" | "requestId" | "requestedModel" | "attemptIndex" | "requestFinal" | "gatewayModelId" | "status" | "usageAvailable" | "usageCompleteness" | "totalTokens" | "inputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "outputTokens" | "pricingConfidence" | "costMicros" | "durationMs" | "completedAt" | "reasoningEffort" | "toolCount" | "requestedServiceTier" | "effectiveServiceTier" | "pricingServiceTier"> & { keyName: string | null; modelName: string | null; gatewayKeyId?: string; startedAt?: string }
export type PublicKeyUsageDetail = { usage: DashboardPayload; recent: { events: RequestLogDisplayEvent[] } }

type GroupableEvent = Pick<UsageEvent, "id" | "requestId" | "attemptIndex" | "completedAt"> & { gatewayKeyId?: string }

export function requestLogGroupId(event: GroupableEvent) {
  return JSON.stringify([event.requestId || event.id, event.gatewayKeyId || ""])
}

/** Only explicit ingress correlation joins attempts. Old records remain standalone. */
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
