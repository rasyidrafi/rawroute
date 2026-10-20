import { serverEvents } from "./events"
import type { LogDetails, LogLevel } from "../contracts/types"
import { requestContext } from "./request-context"
import { logs, type LogAdmission } from "./store"

const labels = new Set(["action", "method", "route", "page", "source", "workspaceId", "errorCode"])
const numbers = new Set(["status", "durationMs", "count", "retryAfter"])
export function safeDetails(input: Record<string, unknown>): LogDetails {
  const result: LogDetails = {}
  for (const [key, value] of Object.entries(input).slice(0, 32)) {
    if (numbers.has(key) && typeof value === "number" && Number.isFinite(value)) result[key] = value
    if (key === "succeeded" && typeof value === "boolean") result[key] = value
    if (labels.has(key) && typeof value === "string" && value.length <= 160
      && /^[a-zA-Z0-9_.:/{} -]+$/.test(value) && !/bearer |sk-|password|secret|token=/i.test(value)) result[key] = value
  }
  return result
}

export type EventCatalog = Readonly<Record<string, { message: string; source: string }>>
export function createRecorder<Catalog extends EventCatalog>(catalog: Catalog, normalize: (input: Record<string, unknown>) => LogDetails = safeDetails) {
  return (event: keyof Catalog & string, details: Record<string, unknown> = {}, options: { level?: LogLevel; scope?: LogAdmission } = {}) => {
    const context = requestContext()
    const definition = catalog[event]
    if (!definition) throw new Error("Unknown operational event.")
    return logs.record({ ...definition, event, level: options.level ?? "info", origin: "server", requestId: context.requestId, details: normalize(details) }, options.scope ?? context.logScope)
  }
}

export const recordLog = createRecorder(serverEvents)
