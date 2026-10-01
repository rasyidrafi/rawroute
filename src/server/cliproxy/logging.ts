import { recordLog } from "@/server/logging/recorder"

export function lifecycleLog(action: string, severity = "INFO", details: Record<string, unknown> = {}) {
  const level = severity === "ERROR" ? "error" : severity === "WARN" ? "warn" : "info"
  recordLog("cliproxy.lifecycle", { ...details, action }, { level, scope: { kind: "global" } })
}
