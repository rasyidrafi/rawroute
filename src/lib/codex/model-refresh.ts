import { scheduleWorkspaceTask } from "@/lib/background-tasks"
import { refreshCodexModels } from "@/lib/codex/model-discovery"

export function scheduleCodexModelRefresh(force = false) {
  void scheduleWorkspaceTask(force ? "codex-models:force" : "codex-models", () => refreshCodexModels(force))
}
