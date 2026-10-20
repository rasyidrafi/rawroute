import type { DashboardPayload, UsageEvent } from "./domain"

export type RequestLogsPage = { events: (UsageEvent & { keyName: string | null; modelName: string | null })[]; nextCursor: string | null; from: string; to: string; models: { id: string; name: string }[]; keys: { id: string; name: string }[] }
export type RequestLogDisplayEvent = Pick<UsageEvent, "id" | "gatewayModelId" | "status" | "usageAvailable" | "usageCompleteness" | "totalTokens" | "inputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "outputTokens" | "pricingConfidence" | "costMicros" | "durationMs" | "completedAt" | "reasoningEffort" | "toolCount"> & { keyName: string | null; modelName: string | null; gatewayKeyId?: string }
export type PublicKeyUsageDetail = { usage: DashboardPayload; recent: { events: RequestLogDisplayEvent[] } }
