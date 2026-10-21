import { z } from "zod"
import type { UsageEvent } from "../contracts/domain"
import { groupRequestLogEvents } from "../contracts/request-logs"

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value)
const filters = z.object({ from: instant, to: instant, status: z.enum(["all", "success", "failed", "recovered", "incomplete"]), model: z.string().max(512), key: z.string().max(512) })
const cursorSchema = filters.extend({ workspace: z.string(), at: instant, id: z.string().min(1).max(512) }).strict()
export type RequestLogQuery = z.infer<typeof filters> & { after?: { at: string; id: string } }

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

export function requestLogLatest(events: UsageEvent[]) {
  return [...events].sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.id.localeCompare(b.id))[0]!
}

export function selectRequestLogGroups(events: UsageEvent[], query: RequestLogQuery) {
  return groupRequestLogEvents(events.filter(event => event.completedAt < query.to)).filter(attempts => {
    const latest = requestLogLatest(attempts)
    const final = attempts.at(-1)!
    const complete = final.requestFinal !== false
    const success = final.status >= 200 && final.status < 300
    const recovered = complete && success && attempts.some(event => event.status < 200 || event.status >= 300)
    return latest.completedAt >= query.from && (!query.model || attempts.some(event => event.gatewayModelId === query.model || event.requestedModel === query.model))
      && (!query.key || latest.gatewayKeyId === query.key)
      && (query.status === "all" || query.status === "incomplete" && !complete || query.status === "success" && complete && success || query.status === "failed" && complete && !success || query.status === "recovered" && recovered)
      && (!query.after || latest.completedAt < query.after.at || latest.completedAt === query.after.at && latest.id > query.after.id)
  }).sort((a, b) => {
    const left = requestLogLatest(a), right = requestLogLatest(b)
    return right.completedAt.localeCompare(left.completedAt) || left.id.localeCompare(right.id)
  }).slice(0, 26).flat()
}
