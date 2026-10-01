import { managedService } from "./service-module"
import { mapConcurrent } from "@/lib/concurrency"
import { hasPendingCodexLogin } from "@/lib/codex/cli-login"
import { CliproxyConflict } from "./admission"
import { cliproxyMode } from "./connection"
import { activeExecutions, drainExecutions, resumeExecutions } from "./admission"
import { withLifecycleMutation, closeManagementMutations } from "./mutations"
import { lifecycleLog } from "./logging"
import { cliProxyHealth } from "@/lib/cliproxy/transport"
import { invalidateProviderProjections, syncNonCodexProviderProjection } from "@/lib/cliproxy/provider-sync"
import { listWorkspaces } from "@/server/workspace-repository"
import { listProviders } from "@/server/store"
import { runInWorkspace } from "@/lib/workspace/context"
import type { CliproxyInstanceStatus } from "@/lib/cliproxy/types"

const globalRuntime = globalThis as typeof globalThis & { rawrouteCliproxyRuntime?: { initialization?: Promise<void>; startupError: string | null; shuttingDown: boolean } }
const runtime = globalRuntime.rawrouteCliproxyRuntime ??= { startupError: null, shuttingDown: false }

async function reconcileProviders() {
  invalidateProviderProjections()
  await mapConcurrent((await listWorkspaces()).filter(workspace => workspace.status === "active"), 4, workspace => runInWorkspace(workspace, async () => {
    await mapConcurrent((await listProviders()).filter(provider => provider.prefix !== "codex"), 4, provider => syncNonCodexProviderProjection(provider.id))
  }))
}

export async function instanceStatus(): Promise<CliproxyInstanceStatus> {
  if (cliproxyMode() === "managed") {
    const service = await managedService()
    const status = await service.getStatus()
    return { ...status, lastError: status.lastError || runtime.startupError, mode: "managed", activeRequests: activeExecutions() }
  }
  const healthy = await cliProxyHealth()
  return { mode: "external", healthy, installed: false, version: null, pinnedVersion: null, desiredRunning: false, processRunning: healthy, conflict: false, operation: null, restartAttempts: 0, lastError: healthy ? null : "External CLIProxy is unavailable.", activeRequests: activeExecutions() }
}

export function initializeInstance() {
  if (cliproxyMode() !== "managed") return Promise.resolve()
  return runtime.initialization ??= (async () => {
    try {
      const service = await managedService()
      // src/index.ts exclusively owns signal ordering and accounting drain.
      const processState = process as typeof process & { __rawrouteCliproxySignals?: boolean }
      processState.__rawrouteCliproxySignals = true
      service.registerCliproxyRecoveryReconciler(reconcileProviders)
      await service.initCliproxy()
      if (!runtime.shuttingDown && (await service.getStatus()).healthy) await reconcileProviders()
    } catch {
      runtime.startupError = "CLIProxy initialization or provider reconciliation failed. Check System Logs and instance configuration."
      lifecycleLog("cliproxy.initialization.failed", "ERROR")
    }
  })()
}

export async function runInstanceAction(action: "install" | "start" | "stop" | "restart", version?: string) {
  if (cliproxyMode() !== "managed") throw new Error("Lifecycle controls require CLIPROXY_MODE=managed.")
  await initializeInstance()
  const service = await managedService()
  return withLifecycleMutation(async () => {
    try {
      if (await hasPendingCodexLogin()) throw new CliproxyConflict("Finish or cancel the pending Codex login before changing the service.")
      await drainExecutions()
      const result = await (action === "install" ? service.install(version!) : service[action]())
      runtime.startupError = null
      if (action !== "stop" && !runtime.shuttingDown && (await service.getStatus()).healthy) await reconcileProviders()
      return result
    } finally { if (!runtime.shuttingDown) resumeExecutions() }
  })
}

export async function shutdownInstance() {
  runtime.shuttingDown = true
  await runtime.initialization
  await closeManagementMutations()
  if (cliproxyMode() === "managed") await (await managedService()).shutdownCliproxy()
}
