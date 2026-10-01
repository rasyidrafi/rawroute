import { managedService } from "./service-module"
import { AsyncLocalStorage } from "node:async_hooks"
import { cliproxyMode } from "./connection"
import { CliproxyConflict } from "./admission"

const runtime = globalThis as typeof globalThis & { rawrouteCliproxyMutations?: { context: AsyncLocalStorage<boolean>; lifecycleContext: AsyncLocalStorage<boolean>; tail: Promise<unknown>; closing: boolean; lifecycleBusy: boolean; lifecycleTask: Promise<unknown> } }
const state = runtime.rawrouteCliproxyMutations ??= { context: new AsyncLocalStorage<boolean>(), lifecycleContext: new AsyncLocalStorage<boolean>(), tail: Promise.resolve(), closing: false, lifecycleBusy: false, lifecycleTask: Promise.resolve() }

/** Reentrant transaction boundary for complete management read/modify/write operations. */
export function withManagementMutation<T>(action: () => Promise<T>): Promise<T> {
  if (state.context.getStore()) return action()
  if ((state.closing || state.lifecycleBusy) && !state.lifecycleContext.getStore()) return Promise.reject(new CliproxyConflict("CLIProxy management is busy or shutting down."))
  const result = state.tail.then(() => state.context.run(true, async () => {
    if (cliproxyMode() === "managed") {
      const { withCliproxyManagementLock } = await managedService()
      return withCliproxyManagementLock(action)
    }
    return action()
  }))
  state.tail = result.catch(() => undefined)
  return result
}

export function withLifecycleMutation<T>(action: () => Promise<T>): Promise<T> {
  if (state.closing || state.lifecycleBusy) return Promise.reject(new CliproxyConflict("A CLIProxy operation is already in progress."))
  state.lifecycleBusy = true
  const result = state.tail.then(() => state.lifecycleContext.run(true, action)).finally(() => { state.lifecycleBusy = false })
  state.lifecycleTask = result.catch(() => undefined)
  return result
}

export async function closeManagementMutations() {
  state.closing = true
  await Promise.all([state.tail, state.lifecycleTask])
}
