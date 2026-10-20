import { scheduleWorkspaceTask } from "@rawroute/platform/server/background-tasks"
import { refreshCodexModels } from "./model-discovery"

export function scheduleCodexModelRefresh(force = false) {
  void scheduleWorkspaceTask(force ? "codex-models:force" : "codex-models", () => refreshCodexModels(force))
}
