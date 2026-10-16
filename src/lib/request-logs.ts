import { z } from "zod"
import type { DashboardPayload, UsageEvent } from "./types"

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value)
const filters = z.object({ from: instant, to: instant, status: z.enum(["all", "success", "failed"]), model: z.string().max(512), key: z.string().max(512) })
const cursorSchema = filters.extend({ workspace: z.string(), at: instant, id: z.string().min(1).max(512) }).strict()
export type RequestLogQuery = z.infer<typeof filters> & { after?: { at: string; id: string } }
export type RequestLogsPage = { events: (UsageEvent & { keyName: string | null; modelName: string | null })[]; nextCursor: string | null; from: string; to: string; models: { id: string; name: string }[]; keys: { id: string; name: string }[] }
export type RequestLogDisplayEvent = Pick<UsageEvent, "id" | "gatewayModelId" | "status" | "usageAvailable" | "usageCompleteness" | "totalTokens" | "inputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "outputTokens" | "pricingConfidence" | "costMicros" | "durationMs" | "completedAt" | "reasoningEffort" | "toolCount"> & { keyName: string | null; modelName: string | null; gatewayKeyId?: string }
export type PublicKeyUsageDetail = { usage: DashboardPayload; recent: { events: RequestLogDisplayEvent[] } }

/** Cursors freeze the selected range and cannot be reused with other filters or workspaces. */
export function parseRequestLogQuery(params: URLSearchParams, workspace: string): RequestLogQuery {
  if ([...params.keys()].some(key => !["from", "to", "status", "model", "key", "cursor"].includes(key)) || [...params.keys()].some(key => params.getAll(key).length !== 1)) throw new Error("Invalid request log parameters")
  const parsed = filters.parse({ from: params.get("from"), to: params.get("to"), status: params.get("status") ?? "all", model: params.get("model") ?? "", key: params.get("key") ?? "" })
  if (parsed.from >= parsed.to) throw new Error("Invalid date range")
  const encoded = params.get("cursor")
  if (encoded === null) return parsed
  if (encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid cursor")
  const cursor = cursorSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString()))
  if (cursor.workspace !== workspace || cursor.from !== parsed.from || cursor.to !== parsed.to || cursor.status !== parsed.status || cursor.model !== parsed.model || cursor.key !== parsed.key || cursor.at < parsed.from || cursor.at >= parsed.to) throw new Error("Cursor does not match the selected workspace or filters")
  return { ...parsed, after: { at: cursor.at, id: cursor.id } }
}

export function requestLogCursor(query: RequestLogQuery, workspace: string, event: UsageEvent) {
  return Buffer.from(JSON.stringify({ from: query.from, to: query.to, status: query.status, model: query.model, key: query.key, workspace, at: event.completedAt, id: event.id })).toString("base64url")
}

export function matchesRequestLog(event: UsageEvent, query: RequestLogQuery) {
  return event.completedAt >= query.from && event.completedAt < query.to && (!query.model || event.gatewayModelId === query.model)
    && (!query.key || event.gatewayKeyId === query.key)
    && (query.status === "all" || (query.status === "success" ? event.status >= 200 && event.status < 300 : event.status < 200 || event.status >= 300))
    && (!query.after || event.completedAt < query.after.at || (event.completedAt === query.after.at && event.id > query.after.id))
}
