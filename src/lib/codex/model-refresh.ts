import { after } from "next/server"
import { refreshCodexModels } from "@/lib/codex/model-discovery"
import { runInWorkspace, workspaceContext } from "@/lib/workspace/context"

export function scheduleCodexModelRefresh(force = false) {
  const workspace = workspaceContext()
  after(() => runInWorkspace(workspace, async () => { await refreshCodexModels(force) }))
}
