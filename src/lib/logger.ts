export type LogLevel = "info" | "warn" | "error"

export interface LogEntry {
  id: string
  timestamp: string
  level: LogLevel
  source: "gateway" | "admin" | "auth" | "system"
  message: string
  details?: Record<string, string | number | boolean>
}

const maxEntries = 500

declare global {
  var __rawrouteLogs: LogEntry[] | undefined
}

function entries() {
  globalThis.__rawrouteLogs ||= []
  return globalThis.__rawrouteLogs
}

export function writeLog(level: LogLevel, source: LogEntry["source"], message: string, details?: LogEntry["details"]) {
  const logs = entries()
  logs.push({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), level, source, message, ...(details ? { details } : {}) })
  if (logs.length > maxEntries) logs.splice(0, logs.length - maxEntries)
}

export function readLogs() {
  return structuredClone(entries()).reverse()
}

export function clearLogs() {
  globalThis.__rawrouteLogs = []
}
