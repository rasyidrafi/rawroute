import type { LogEntry } from "./types"

export function formatLog(entry: LogEntry) {
  const details = Object.entries(entry.details).map(([key, value]) => `${key}=${value}`).join(" ")
  return `${entry.timestamp} ${entry.level.toUpperCase()} [${entry.source}] ${entry.message} event=${entry.event} origin=${entry.origin} scope=${entry.scope}${entry.workspaceId ? ` workspaceId=${entry.workspaceId}` : ""}${entry.requestId ? ` requestId=${entry.requestId}` : ""}${details ? ` ${details}` : ""}`
}
