import { useWorkspace } from "../workspace-provider"
import { LogPanel } from "./logs/log-panel"

export function ConsoleLog() {
  const { workspace } = useWorkspace()
  return workspace ? <LogPanel key={workspace.id} scope={{ kind: "workspace", workspaceId: workspace.id }} /> : null
}

export function SystemLogs() {
  return <LogPanel scope={{ kind: "global" }} />
}
