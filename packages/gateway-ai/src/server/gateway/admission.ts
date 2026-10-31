/** Tracks inference and account-redemption work so shutdown can drain before SQLite closes. */
const runtime = globalThis as typeof globalThis & { rawrouteGatewayAdmission?: { draining: boolean; executions: number } }
const state = runtime.rawrouteGatewayAdmission ??= { draining: false, executions: 0 }

export class GatewayDrainConflict extends Error {
  readonly status = 503
}

export function activeGatewayExecutions() {
  return state.executions
}

export function admitGatewayExecution() {
  if (state.draining) throw new GatewayDrainConflict("Gateway is shutting down. Retry shortly.")
  state.executions++
  let released = false
  return () => {
    if (released) return
    released = true
    state.executions--
  }
}

export async function drainGatewayExecutions(timeoutMs = 30_000) {
  state.draining = true
  const deadline = Date.now() + timeoutMs
  while (state.executions) {
    if (Date.now() >= deadline) throw new GatewayDrainConflict("Gateway requests are still running; shutdown cannot close the database yet.")
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

export function resumeGatewayExecutions() {
  state.draining = false
}
