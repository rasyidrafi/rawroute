export type LogLevel = "info" | "warn" | "error"
export type LogScope = { kind: "global" } | { kind: "workspace"; workspaceId: string }
export type LogDetails = Record<string, string | number | boolean | null>

export interface LogEntry {
  id: string
  timestamp: string
  level: LogLevel
  source: string
  event: string
  message: string
  origin: "server" | "browser"
  scope: LogScope["kind"]
  workspaceId: string | null
  requestId: string | null
  details: LogDetails
}

export interface LogSnapshot {
  scope: LogScope["kind"]
  workspaceId: string | null
  entries: LogEntry[]
  capacity: number
  evicted: number
}
