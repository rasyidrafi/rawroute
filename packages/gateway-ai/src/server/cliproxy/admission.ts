/** Owned by the server process, including across Bun hot reloads. */
const runtime = globalThis as typeof globalThis & { rawrouteCliproxyAdmission?: { draining: boolean; executions: number } }
const state = runtime.rawrouteCliproxyAdmission ??= { draining: false, executions: 0 }

export class CliproxyConflict extends Error { readonly status = 409 }

export function activeExecutions() { return state.executions }

export function admitExecution() {
  if (state.draining) throw new CliproxyConflict("CLIProxy is draining requests for maintenance. Retry shortly.")
  state.executions++
  let released = false
  return () => { if (!released) { released = true; state.executions-- } }
}

export async function drainExecutions(timeoutMs = 30_000) {
  state.draining = true
  const deadline = Date.now() + timeoutMs
  while (state.executions) {
    if (Date.now() >= deadline) throw new CliproxyConflict("Requests are still running. The service was left running; retry after they finish.")
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

export function resumeExecutions() { state.draining = false }
