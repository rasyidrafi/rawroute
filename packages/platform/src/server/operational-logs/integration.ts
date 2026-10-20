import type { Workspace } from "../../contracts/workspace"
import type { BrowserEvent } from "@rawroute/observability/contracts/browser-events"
import type { LogScope } from "@rawroute/observability/contracts/types"

export interface ObservabilityServerDependencies {
  getWorkspace(id: string): Promise<Workspace | undefined>
  runInWorkspace<T>(workspace: Workspace, callback: () => T): T
  browserEventScope(event: BrowserEvent, page: unknown): LogScope["kind"] | undefined
}
let dependencies: ObservabilityServerDependencies | undefined
export function configureObservabilityServer(value: ObservabilityServerDependencies) { dependencies = value }
export function observabilityDependencies() {
  if (!dependencies) throw new Error("Observability server must be configured before use.")
  return dependencies
}
