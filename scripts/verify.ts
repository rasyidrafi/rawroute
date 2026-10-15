import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { join } from "node:path"

const commands = {
  test: ["bun", "run", "test"],
  lint: ["bun", "run", "lint"],
  typecheck: ["bun", "run", "typecheck"],
  build: ["bun", "run", "build"],
  browser: ["bunx", "--bun", "playwright", "test"],
} as const

export type Check = keyof typeof commands
type Result = { check: Check; status: "passed" | "failed" | "blocked"; seconds: number; detail?: string }

// Two bounded branches, not concurrent test files. Lint must finish before Chrome
// creates trace/cache files; dist must not be rebuilt while Chrome serves it.
export async function verify(execute: (check: Check) => Promise<number>, cpus = availableParallelism(), signal?: AbortSignal) {
  const results: Result[] = []
  async function run(check: Check): Promise<Result> {
    const start = performance.now()
    let result: Result
    if (signal?.aborted) {
      result = { check, status: "blocked", seconds: 0, detail: "interrupted" }
    } else {
      try {
        const code = await execute(check)
        result = { check, status: code === 0 && !signal?.aborted ? "passed" : "failed", seconds: (performance.now() - start) / 1000, detail: signal?.aborted ? "interrupted" : code === 0 ? undefined : `exit ${code}` }
      } catch (error) {
        result = { check, status: "failed", seconds: (performance.now() - start) / 1000, detail: String(error) }
      }
    }
    results.push(result)
    return result
  }
  async function productionChecks() {
    await run("lint")
    await run("typecheck")
    const build = await run("build")
    if (build.status === "passed") await run("browser")
    else results.push({ check: "browser", status: "blocked", seconds: 0, detail: "production build did not pass" })
  }
  const units = run("test")
  if (cpus < 2) await units
  await Promise.all([units, productionChecks()])
  return results
}

// Interrupt each check's process group, then escalate. Playwright handles SIGINT
// to clean up its own detached browser/web-server groups before exiting.
export async function runProcess(command: readonly string[], log: string, signal: AbortSignal) {
  if (signal.aborted) return 130
  const fd = openSync(log, "w")
  let cleanup: Promise<void> | undefined
  try {
    // The verify entrypoint uses --no-env-file so this native inheritance does
    // not leak the development .env.local into `bun test` (which ignores it).
    const child = Bun.spawn([...command], { stdout: fd, stderr: fd, stdin: "ignore", detached: true })
    const stop = () => {
      if (cleanup) return
      cleanup = (async () => {
        if (process.platform === "win32") {
          await Bun.spawn(["taskkill", "/pid", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
          return
        }
        function kill(signal: NodeJS.Signals) {
          try { process.kill(-child.pid, signal) } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
          }
        }
        kill("SIGINT")
        await Bun.sleep(2000)
        kill("SIGKILL")
      })()
    }
    signal.addEventListener("abort", stop, { once: true })
    try {
      if (signal.aborted) stop()
      const code = await child.exited
      await cleanup
      return code
    } finally {
      signal.removeEventListener("abort", stop)
    }
  } finally {
    closeSync(fd)
  }
}

if (import.meta.main) {
  const start = performance.now()
  const logs = mkdtempSync(join(tmpdir(), "rawroute-verify-"))
  const controller = new AbortController()
  let interrupted = 0
  const interrupt = (signal: NodeJS.Signals) => {
    interrupted = signal === "SIGINT" ? 130 : 143
    controller.abort()
  }
  const sigint = () => interrupt("SIGINT")
  const sigterm = () => interrupt("SIGTERM")
  process.on("SIGINT", sigint)
  process.on("SIGTERM", sigterm)
  console.log(`Verification: ${Math.min(2, availableParallelism())} branches; logs: ${logs}`)
  try {
    const results = await verify(async check => {
      const log = join(logs, `${check}.log`)
      console.log(`\n[${check}] started (${commands[check].join(" ")})`)
      const code = await runProcess(commands[check], log, controller.signal)
      // Group output by check, preserving warnings and full diagnostics on success too.
      process.stdout.write(readFileSync(log))
      console.log(`[${check}] finished: exit ${code}; log: ${log}`)
      return code
    }, availableParallelism(), controller.signal)
    console.log("\nVerification summary:")
    for (const check of Object.keys(commands) as Check[]) {
      const result = results.find(result => result.check === check)
      if (result) console.log(`${result.status.toUpperCase().padEnd(7)} ${check.padEnd(10)} ${result.seconds.toFixed(2)}s${result.detail ? ` (${result.detail})` : ""}`)
    }
    console.log(`Total: ${((performance.now() - start) / 1000).toFixed(2)}s; logs: ${logs}`)
    process.exitCode = interrupted || (results.every(result => result.status === "passed") ? 0 : 1)
  } finally {
    process.off("SIGINT", sigint)
    process.off("SIGTERM", sigterm)
  }
}
