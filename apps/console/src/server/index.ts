import { aiServer } from "@rawroute/gateway-ai/server/integration"
import { storageServer } from "@rawroute/gateway-storage/server/integration"
import { recordLog } from "@rawroute/observability/server/recorder"
import { serve } from "bun"
import index from "../frontend/index.html"

import { drainBackgroundTasks } from "@rawroute/platform/server/background-tasks"
import { notFoundResponse, notFoundStylesResponse } from "./not-found"
import { closeLocalDatabase, ensureLocalDatabase } from "@rawroute/platform/server/database"
import { closeLocalCache } from "@rawroute/platform/server/local-cache"
import { isPagePath, pagePaths } from "../frontend/contracts/dashboard/routes"
import { apiRoutes } from "./routes"
import { recoverWorkspaceDeletions } from "@rawroute/platform/server/runtime"
import { drainWorkspaceDeletions } from "@rawroute/platform/server/workspace-repository"
import { isMemoryBackend } from "@rawroute/platform/server/storage-config"

const port = Number(process.env.PORT || 3000)
aiServer.initializePersistence()
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535.")
storageServer.preparePersistence()
if (!isMemoryBackend()) await ensureLocalDatabase()
// Resume AI cleanup only after its shared engine has had a chance to recover.
await aiServer.start()
try { await storageServer.start() } catch (error) { await aiServer.stop(); throw error }
await recoverWorkspaceDeletions()

const server = serve({
  port,
  hostname: process.env.HOSTNAME || "0.0.0.0",
  development: process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
  idleTimeout: 60,
  maxRequestBodySize: 128 * 1024 * 1024,
  routes: {
    ...Object.fromEntries(Object.values(pagePaths).map((path) => [path, { GET: index, HEAD: index }])),
    ...apiRoutes,
    "/not-found.css": { GET: notFoundStylesResponse, HEAD: notFoundStylesResponse },
  },
  fetch(request) {
    const url = new URL(request.url)
    // Keep method errors separate from missing browser pages and API endpoints.
    if (isPagePath(url.pathname)) return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
    return notFoundResponse(request)
  },
})

console.log(`RawRoute listening on ${server.url}`)
recordLog("system.started")

let shutdown: Promise<void> | undefined
function stop() {
  if (shutdown) return shutdown
  shutdown = (async () => {
    recordLog("system.stopping")
    const force = setTimeout(() => { void server.stop(true) }, 30_000)
    try {
      await Promise.all([server.stop(false), storageServer.stop()])
      // Stream monitoring must settle budgets before storage and cache close.
      await drainBackgroundTasks()
      await drainWorkspaceDeletions()
      await aiServer.stop()
      await Promise.all([closeLocalDatabase(), closeLocalCache()])
    } finally {
      clearTimeout(force)
    }
    recordLog("system.stopped")
  })().catch((error: unknown) => {
    recordLog("system.shutdown.failed", {}, { level: "error" })
    console.error("RawRoute shutdown failed", error)
    process.exitCode = 1
  })
  return shutdown
}

const onSignal = () => { void stop().then(() => process.exit(process.exitCode ?? 0)) }
// Server --hot reloads keep the process alive. Replace listeners from the
// previous module evaluation so one signal drains only the current server.
const lifecycle = globalThis as typeof globalThis & { rawrouteOnSignal?: () => void }
if (lifecycle.rawrouteOnSignal) {
  process.off("SIGINT", lifecycle.rawrouteOnSignal)
  process.off("SIGTERM", lifecycle.rawrouteOnSignal)
}
lifecycle.rawrouteOnSignal = onSignal
process.once("SIGINT", onSignal)
process.once("SIGTERM", onSignal)
