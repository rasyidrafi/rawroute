import { AsyncLocalStorage } from "node:async_hooks"
import { runWithAuditIdentity } from "./audit-context"
import { logs, type LogAdmission } from "./store"

type RequestContext = { requestId: string | null; logScope: LogAdmission }
declare global { var __rawrouteRequestContext: AsyncLocalStorage<RequestContext> | undefined }
const storage = globalThis.__rawrouteRequestContext ||= new AsyncLocalStorage<RequestContext>()

export function requestContext(): RequestContext {
  return storage.getStore() ?? { requestId: null, logScope: { kind: "global" } }
}

export function runInRequest<T>(callback: () => T): T {
  const requestId = crypto.randomUUID()
  return storage.run({ requestId, logScope: { kind: "global" } }, () => runWithAuditIdentity("anonymous", requestId, callback))
}

export function runWithWorkspaceLogScope<T>(workspaceId: string, callback: () => T): T {
  const current = requestContext()
  // Nested work retains the original admission, including after workspace deletion.
  const logScope = current.logScope.kind === "workspace" && current.logScope.workspaceId === workspaceId
    ? current.logScope : logs.admitWorkspace(workspaceId)
  return storage.run({ ...current, logScope }, callback)
}
