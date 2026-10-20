import { AsyncLocalStorage } from "node:async_hooks"

type Lease = { workspaceId: string; active: boolean; pending: number; dependencies?: Map<string, Lease> }
declare global {
  var __rawrouteWorkspaceActivity: {
    scope: AsyncLocalStorage<Lease>
    closed: Set<string>
    leases: Map<string, Set<Lease>>
    waiters: Map<string, Set<() => void>>
  } | undefined
}
// Bun hot reload must not lose admissions held by existing streams/jobs.
const { scope, closed, leases, waiters } = globalThis.__rawrouteWorkspaceActivity ||= {
  scope: new AsyncLocalStorage<Lease>(), closed: new Set<string>(), leases: new Map<string, Set<Lease>>(), waiters: new Map<string, Set<() => void>>(),
}

function release(lease: Lease) {
  if (--lease.pending > 0) return
  lease.active = false
  for (const dependency of lease.dependencies?.values() || []) release(dependency)
  leases.get(lease.workspaceId)?.delete(lease)
  if (leases.get(lease.workspaceId)?.size) return
  leases.delete(lease.workspaceId)
  for (const resolve of waiters.get(lease.workspaceId) || []) resolve()
  waiters.delete(lease.workspaceId)
}

export function assertWorkspaceActivity(workspaceId: string) {
  const lease = scope.getStore()
  if (lease && !lease.active) throw new Error("Workspace activity has settled.")
  if (closed.has(workspaceId) && !admitted(lease, workspaceId)) throw new Error("Workspace is unavailable.")
}

function admitted(lease: Lease | undefined, workspaceId: string) {
  if (!lease?.active) return undefined
  return lease.workspaceId === workspaceId ? lease : lease.dependencies?.get(workspaceId)
}

function createLease(workspaceId: string): Lease {
  const lease: Lease = { workspaceId, active: true, pending: 1 }
  const entries = leases.get(workspaceId) || new Set<Lease>()
  entries.add(lease)
  leases.set(workspaceId, entries)
  return lease
}

/** Shared-model owners remain admitted until the consumer stream/accounting settles. */
export function attachWorkspaceActivity(workspaceId: string) {
  const parent = scope.getStore()
  if (!parent?.active) throw new Error("Workspace activity is required.")
  if (admitted(parent, workspaceId)) return
  assertWorkspaceActivity(workspaceId)
  parent.dependencies ||= new Map()
  parent.dependencies.set(workspaceId, createLease(workspaceId))
}

/** Synchronous admission closes the race between request validation and deletion. */
export function runWorkspaceActivity<T>(workspaceId: string, callback: () => T): T {
  assertWorkspaceActivity(workspaceId)
  const inherited = admitted(scope.getStore(), workspaceId)
  if (inherited) return scope.run(inherited, callback)
  const lease = createLease(workspaceId)
  return executeWithLease(lease, callback)
}

function executeWithLease<T>(lease: Lease, callback: () => T): T {
  return scope.run(lease, () => {
    try {
      const result = callback()
      if (result instanceof Promise) return result.finally(() => release(lease)) as T
      release(lease)
      return result
    } catch (error) {
      release(lease)
      throw error
    }
  })
}

/** Accounting/stream monitors retain the admitting lease, not a fresh admission. */
export function retainWorkspaceActivity<T>(task: Promise<T>): Promise<T> {
  const lease = scope.getStore()
  if (!lease) return task
  assertWorkspaceActivity(lease.workspaceId)
  lease.pending += 1
  return task.finally(() => release(lease))
}

export function closeWorkspaceAdmission(workspaceId: string) { closed.add(workspaceId) }
export function assertOutsideWorkspaceActivity(workspaceId: string) {
  if (admitted(scope.getStore(), workspaceId)) throw new Error("Workspace deletion must run outside its admitted activity.")
}
export function reopenWorkspaceAdmission(workspaceId: string) { closed.delete(workspaceId) }
/** Coordinator-only capability; never used to admit HTTP or scheduled work. */
export function runWorkspaceCleanup<T>(workspaceId: string, callback: () => T): T {
  return executeWithLease(createLease(workspaceId), callback)
}
export function runWithoutWorkspaceActivity<T>(callback: () => T): T { return scope.exit(callback) }
export async function drainWorkspaceActivity(workspaceId: string) {
  if (!leases.get(workspaceId)?.size) return
  await new Promise<void>(resolve => {
    const entries = waiters.get(workspaceId) || new Set<() => void>()
    entries.add(resolve)
    waiters.set(workspaceId, entries)
  })
}
