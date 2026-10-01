import { writeLog } from "@/lib/logger"
import { runInWorkspace, workspaceContext } from "@/lib/workspace/context"
import { getWorkspace } from "@/server/workspace-repository"

const pending = new Set<Promise<void>>()
const scheduled = new Map<string, Promise<void>>()

/** Track work already started by a request so shutdown can drain accounting. */
export function trackBackgroundTask(task: Promise<void>) {
  const tracked = task.catch((error: unknown) => {
    writeLog("error", "system", "Background task failed", { error: error instanceof Error ? error.message : "Unknown error" })
  }).finally(() => pending.delete(tracked))
  pending.add(tracked)
  return tracked
}

/** Jobs carry their workspace explicitly and cannot restart deleted workspaces. */
export function scheduleWorkspaceTask(name: string, callback: () => Promise<unknown>) {
  const workspace = workspaceContext()
  const key = `${workspace.id}:${name}`
  const existing = scheduled.get(key)
  if (existing) return existing
  const task = trackBackgroundTask(new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
    const active = await getWorkspace(workspace.id)
    if (!active || active.status !== "active") return
    await runInWorkspace(active, callback)
  })).finally(() => scheduled.delete(key))
  scheduled.set(key, task)
  return task
}

export async function drainBackgroundTasks() {
  while (pending.size) await Promise.all([...pending])
}
