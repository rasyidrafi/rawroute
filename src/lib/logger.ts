import { currentWorkspaceId } from "@/lib/workspace-context"

export type LogLevel = "info" | "warn" | "error"

export interface LogEntry {
  id: string
  timestamp: string
  level: LogLevel
  source: "gateway" | "admin" | "auth" | "system"
  workspaceId?: string
  message: string
  details?: Record<string, string | number | boolean>
}

const maxEntries = 500

declare global {
  var __rawrouteLogRing: { entries: Array<LogEntry | undefined>; next: number; size: number; revision: number; instanceId: string } | undefined
}

function entries() {
  const ring = globalThis.__rawrouteLogRing ||= {
    entries: new Array<LogEntry | undefined>(maxEntries),
    next: 0,
    size: 0,
    revision: 0,
    instanceId: crypto.randomUUID(),
  }
  // Development hot reload can preserve an older global ring shape.
  ring.revision ||= 0
  ring.instanceId ||= crypto.randomUUID()
  return ring
}

export function writeLog(level: LogLevel, source: LogEntry["source"], message: string, details?: LogEntry["details"]) {
  const ring = entries()
  ring.revision += 1
  ring.entries[ring.next] = { id: `${ring.instanceId}-${ring.revision}`, timestamp: new Date().toISOString(), level, source, workspaceId: currentWorkspaceId(), message, ...(details ? { details } : {}) }
  ring.next = (ring.next + 1) % maxEntries
  ring.size = Math.min(maxEntries, ring.size + 1)
}

export function logVersion() {
  const ring = entries()
  return `${ring.instanceId}-${ring.revision}`
}

export function readLogs() {
  const ring = entries()
  const out: LogEntry[] = []
  for (let index = 0; index < ring.size; index++) {
    const position = (ring.next - 1 - index + maxEntries) % maxEntries
    const entry = ring.entries[position]
    if (entry?.workspaceId === currentWorkspaceId()) out.push(entry)
  }
  return structuredClone(out)
}

export function clearLogs() {
  const current = entries()
  const retained = readAllLogs().filter((entry) => entry.workspaceId !== currentWorkspaceId())
  globalThis.__rawrouteLogRing = {
    entries: new Array<LogEntry | undefined>(maxEntries),
    next: 0,
    size: 0,
    revision: current.revision + 1,
    instanceId: current.instanceId,
  }
  const ring = entries()
  for (const entry of retained.reverse()) {
    ring.entries[ring.next] = entry
    ring.next = (ring.next + 1) % maxEntries
    ring.size = Math.min(maxEntries, ring.size + 1)
  }
}

function readAllLogs() {
  const ring = entries()
  const out: LogEntry[] = []
  for (let index = 0; index < ring.size; index++) {
    const position = (ring.next - 1 - index + maxEntries) % maxEntries
    const entry = ring.entries[position]
    if (entry) out.push(entry)
  }
  return out
}
