// Offline only: the coordinator owns a fresh directory and never inherits application configuration.
import { copyFileSync, existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import type { DashboardQuery, UsageEvent } from "../../packages/gateway-ai/src/contracts/domain"

const end = Date.parse("2026-10-15T00:00:00.000Z")
const start = end - 30 * 86_400_000
const workspaces = ["perf-a", "perf-b"]
const worker = ["seed", "budgets", "read", "writes"].includes(process.argv[2] || "") ? process.argv[2] : undefined
const count = Number(process.argv[worker ? 3 : 2] || 10_000)
const trials = Number(process.argv[worker ? 4 : 3] || 3)
if (!Number.isSafeInteger(count) || count < 100 || count > 100_000 || !Number.isSafeInteger(trials) || trials < 1 || trials > 10) throw new Error("Sizes: 100..100000; trials: 1..10")

function event(index: number): UsageEvent {
  const completedAt = new Date(start + Math.floor(index / count * (end - start))).toISOString()
  const result: UsageEvent = {
    id: `event-${index}`, gatewayKeyId: `key-${index % 4}`, gatewayModelId: `synthetic/model-${Math.floor(index / 4) % 3}`,
    protocol: "openai-chat", startedAt: completedAt, completedAt, status: index % 11 ? 200 : 500,
    durationMs: index % 7 ? 100 + index % 1000 : 0,
    inputTokens: 100, outputTokens: index % 11 ? 20 : 0, totalTokens: index % 11 ? 120 : 100,
    cacheReadTokens: index % 3 ? 25 : 0, cacheCreationTokens: index % 5 ? 0 : 10,
    costMicros: index % 11 ? 140 : 0, pricingConfidence: "exact", usageAvailable: true,
  }
  // Exercise historical records whose duration is absent without changing the event API.
  if (index % 13 === 0) Reflect.deleteProperty(result, "durationMs")
  return result
}

if (!worker) {
  const directory = mkdtempSync("/tmp/opencode/dashboard-perf-9eba132-")
  const environment = {
    PATH: process.env.PATH || "/usr/bin:/bin", HOME: directory, TMPDIR: directory,
    SQLITE_PATH: join(directory, "synthetic.sqlite"), RAWROUTE_DATA_DIR: directory,
    STORAGE_BACKEND: "sqlite", NODE_ENV: "development", TIMEZONE: "UTC", DATABASE_COLLECTION_PREFIX: "perf",
  }
  let sequence = 0
  const measurements = new Map<string, { durations: number[]; bytes: number[] }>()
  async function run(mode: string, extra: string[] = [], logging = true) {
    const path = mode === "read" || mode === "writes" ? join(directory, `trial-${sequence}.sqlite`) : environment.SQLITE_PATH
    if (path !== environment.SQLITE_PATH) copyFileSync(environment.SQLITE_PATH, path)
    const child = Bun.spawn([process.execPath, "run", "--no-env-file", import.meta.path, mode, String(count), String(trials), ...extra], {
      env: { ...environment, SQLITE_PATH: path, DASHBOARD_PERF_LOG: logging ? "1" : "0" }, stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    writeFileSync(join(directory, `${sequence++}-${mode}.log`), stdout + stderr)
    if (code) throw new Error(`Worker ${mode} failed: ${stderr}; logs: ${directory}`)
    if (path !== environment.SQLITE_PATH) for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix)
    for (const line of stdout.split("\n")) if (line.startsWith('{"benchmark"')) {
      console.log(line)
      const sample = JSON.parse(line) as Record<string, unknown>
      if (typeof sample.phase !== "string" || typeof sample.elapsedMs !== "number" || typeof sample.bytes !== "number") continue
      const key = `${sample.budget}/${sample.scenario}/${sample.phase}`
      const group = measurements.get(key) || { durations: [], bytes: [] }
      group.durations.push(sample.elapsedMs)
      group.bytes.push(sample.bytes)
      measurements.set(key, group)
    }
  }
  console.log(JSON.stringify({ benchmark: "metadata", directory, bun: Bun.version, count, trials, workspaces: 2, keysPerWorkspace: 4, modelsPerWorkspace: 3, from: new Date(start), to: new Date(end), cold: "fresh process/application caches; NOT filesystem cold" }))
  await run("seed", [], false)
  for (const budget of [false, true]) {
    if (budget) await run("budgets", [], false)
    for (const scenario of ["overview-1-aligned", "overview-7-aligned", "overview-30-aligned", "overview-1-partial", "overview-7-partial", "overview-30-partial", "private-all", "public-all", "private-budget", "public-budget"]) {
      for (let trial = 0; trial < trials; trial++) await run("read", [scenario, String(budget), String(trial)])
    }
  }
  await run("writes", [], false)
  await run("writes", [], true)
  for (const [scenario, { durations, bytes }] of measurements) {
    durations.sort((a, b) => a - b)
    const middle = Math.floor(durations.length / 2)
    const medianMs = durations.length % 2 ? durations[middle] : (durations[middle - 1]! + durations[middle]!) / 2
    console.log(JSON.stringify({ benchmark: "summary", scenario, trials: durations.length, medianMs, minMs: durations[0], maxMs: durations.at(-1), minBytes: Math.min(...bytes), maxBytes: Math.max(...bytes) }))
  }
  console.log(JSON.stringify({ benchmark: "complete", directory }))
} else {
  if (!process.env.SQLITE_PATH?.startsWith("/tmp/opencode/dashboard-perf-9eba132-") || process.env.STORAGE_BACKEND !== "sqlite" || process.env.NODE_ENV !== "development") throw new Error("Worker requires coordinator-owned SQLite environment")
  if (worker === "seed" && existsSync(process.env.SQLITE_PATH)) throw new Error("Refusing to seed an existing database")
  const rejectNetwork = () => { throw new Error("Offline benchmark forbids network access") }
  globalThis.fetch = Object.assign(rejectNetwork, { preconnect: rejectNetwork })
  await import("../../apps/console/src/server/composition")
  const analytics = await import("../../packages/gateway-ai/src/server/analytics")
  const { runInWorkspace } = await import("../../packages/platform/src/server/workspace-context")
  const { closeLocalDatabase, getSqliteDatabase } = await import("../../packages/platform/src/server/database")
  const { initializeAiPersistence } = await import("../../packages/gateway-ai/src/server/local-db")
  initializeAiPersistence()
  const context = { usageStartAt: new Date(start).toISOString(), windowEnd: new Date(Math.max(end + 86_400_000, (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000)).toISOString() }
  const scoped = <T>(id: string, fn: () => T) => runInWorkspace({ id, storageMode: "scoped" }, fn)
  const report = (value: Record<string, unknown>) => console.log(JSON.stringify({ benchmark: worker, ...value }))
  if (worker === "seed") {
    for (const workspace of workspaces) {
      // Deterministic, synthetic metadata only; these are not live gateway credentials.
      const root = getSqliteDatabase().collection("perf_workspaces").doc(workspace)
      for (let key = 0; key < 4; key++) await root.collection("apiKeys").doc(`key-${key}`).set({ name: `Synthetic ${key}`, key: `offline-${workspace}-${key}`, createdAt: context.usageStartAt })
      await scoped(workspace, () => analytics.updateBudgetWindow({ anchor: "custom", start: context.usageStartAt, end: context.windowEnd }))
    }
    const began = performance.now()
    for (let i = 0; i < count; i++) await scoped(workspaces[Math.floor(i / 12) % 2]!, () => analytics.recordUsageEvent(event(i), context))
    report({ events: count, elapsedMs: performance.now() - began })
  } else if (worker === "budgets") {
    for (const workspace of workspaces) await scoped(workspace, async () => {
      await analytics.updateBudgetWindow({ anchor: "custom", start: context.usageStartAt, end: context.windowEnd })
      for (let key = 0; key < 4; key++) await analytics.upsertBudget({ apiKeyId: `key-${key}`, enabled: true, weeklyLimitMicros: 1_000_000_000 })
    })
  } else if (worker === "read") {
    const scenario = process.argv[5]!
    const budget = process.argv[6]
    const trial = process.argv[7]
    await scoped("perf-a", async () => {
      const read = () => {
        if (scenario.startsWith("overview")) {
          const days = Number(scenario.split("-")[1])
          const offset = scenario.endsWith("partial") ? 1_234_567 : 0
          return analytics.getOverviewPayload({ from: new Date(end - days * 86_400_000 + offset).toISOString(), to: new Date(end + offset).toISOString() })
        }
        const query: DashboardQuery = { preset: scenario.endsWith("budget") ? "budget" : "all" }
        return analytics.getDashboardPayload(query, scenario.startsWith("public"))
      }
      for (const phase of ["cold", "warm", "postwrite"]) {
        if (phase === "postwrite") await analytics.recordUsageEvent({ ...event(0), id: `post-${scenario}-${budget}-${trial}`, completedAt: new Date(end - 1).toISOString() }, context)
        const began = performance.now()
        const payload = await read()
        const elapsedMs = performance.now() - began
        const normalized = { ...payload, range: scenario.endsWith("all") ? { ...payload.range, to: "excluded-wall-clock" } : payload.range } as Partial<typeof payload>
        delete normalized.generatedAt
        delete normalized.coverage
        const json = JSON.stringify(normalized)
        const hash = createHash("sha256").update(json).digest("hex")
        writeFileSync(join(process.env.RAWROUTE_DATA_DIR!, `payload-${scenario}-${budget}-${trial}-${phase}.json`), JSON.stringify(payload))
        report({ scenario, budget, trial, phase, elapsedMs, bytes: Buffer.byteLength(JSON.stringify(payload)), hash, coverage: payload.coverage, responseHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), requests: payload.summary.requests, from: payload.range.from, to: payload.range.to })
      }
    })
  } else if (worker === "writes") {
    const timings: number[] = []
    for (let i = 0; i < 100; i++) await scoped("perf-b", async () => {
      const began = performance.now()
      await analytics.recordUsageEvent({ ...event(i), id: `overhead-${process.env.DASHBOARD_PERF_LOG}-${i}` }, context)
      timings.push(performance.now() - began)
    })
    timings.sort((a, b) => a - b)
    report({ logging: process.env.DASHBOARD_PERF_LOG, medianMs: timings[50], minMs: timings[0], maxMs: timings.at(-1) })
  } else throw new Error("Unknown worker mode")
  const { Database } = await import("bun:sqlite")
  const database = new Database(process.env.SQLITE_PATH!, { readonly: true })
  report({ rows: database.query("SELECT collection_path, count(*) AS count FROM rawroute_documents GROUP BY collection_path").all() })
  report({ projectionRows: database.query("SELECT workspaceId,granularity,count(*) AS count FROM usage_buckets GROUP BY workspaceId,granularity").all(), historyRows: database.query("SELECT disposition,count(*) AS count FROM usage_projection_history GROUP BY disposition").all() })
  database.close()
  await closeLocalDatabase()
}
