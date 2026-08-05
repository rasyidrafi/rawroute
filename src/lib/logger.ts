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
  var __rawrouteLogRing: { entries: Array<LogEntry | undefined>; next: number; size: number } | undefined
}

function entries() {
  globalThis.__rawrouteLogRing ||= { entries: new Array<LogEntry | undefined>(maxEntries), next: 0, size: 0 }
  return globalThis.__rawrouteLogRing
}

export function writeLog(level: LogLevel, source: LogEntry["source"], message: string, details?: LogEntry["details"]) {
  const ring = entries()
  ring.entries[ring.next] = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), level, source, message, ...(details ? { details } : {}) }
  ring.next = (ring.next + 1) % maxEntries
  ring.size = Math.min(maxEntries, ring.size + 1)
}

export function readLogs() {
  const ring = entries()
  const out: LogEntry[] = []
  for (let index = 0; index < ring.size; index++) {
    const position = (ring.next - 1 - index + maxEntries) % maxEntries
    const entry = ring.entries[position]
    if (entry) out.push(entry)
  }
  return structuredClone(out)
}

export function clearLogs() {
  globalThis.__rawrouteLogRing = { entries: new Array<LogEntry | undefined>(maxEntries), next: 0, size: 0 }
}
