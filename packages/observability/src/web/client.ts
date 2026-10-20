import type { BrowserEvent } from "../contracts/browser-events"
import type { LogScope } from "../contracts/types"

/** Nonblocking, bounded reports. Never send arbitrary text, errors or copied values. */
export function reportEvent(report: { event: BrowserEvent; page?: string }, scope: LogScope) {
  void fetch("/api/admin/logs/events", {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", ...(scope.kind === "workspace" ? { "x-rawroute-workspace-id": scope.workspaceId } : {}) },
    body: JSON.stringify(report), signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
}
