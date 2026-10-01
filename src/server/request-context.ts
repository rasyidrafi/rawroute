import { AsyncLocalStorage } from "node:async_hooks"
import { logs, type LogAdmission } from "./logging/store"

type RequestContext = { requestId: string | null; logScope: LogAdmission }
const storage = new AsyncLocalStorage<RequestContext>()

export function requestContext(): RequestContext {
  return storage.getStore() ?? { requestId: null, logScope: { kind: "global" } }
}

export function runInRequest<T>(callback: () => T): T {
  return storage.run({ requestId: crypto.randomUUID(), logScope: { kind: "global" } }, callback)
}

export function runWithWorkspaceLogScope<T>(workspaceId: string, callback: () => T): T {
  const current = requestContext()
  // Nested work retains the original admission, including after workspace deletion.
  const logScope = current.logScope.kind === "workspace" && current.logScope.workspaceId === workspaceId
    ? current.logScope : logs.admitWorkspace(workspaceId)
  return storage.run({ ...current, logScope }, callback)
}
