import { recordLog } from "@/server/logging/recorder"
import { serve } from "bun"
import index from "./index.html"

import { drainBackgroundTasks } from "@/lib/background-tasks"
import { jsonError } from "@/lib/http"
import { closeLocalDatabase } from "@/lib/local-db"
import { closeLocalRedis } from "@/lib/local-redis"
import { isPagePath, pagePaths, pageRedirects } from "@/lib/page-routes"
import { apiRoutes } from "@/server/routes"

const port = Number(process.env.PORT || 3000)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535.")

const server = serve({
  port,
  hostname: process.env.HOSTNAME || "0.0.0.0",
  development: process.env.NODE_ENV === "production" ? false : { hmr: true, console: true },
  idleTimeout: 60,
  maxRequestBodySize: 128 * 1024 * 1024,
  routes: {
    ...Object.fromEntries(Object.values(pagePaths).map((path) => [path, { GET: index, HEAD: index }])),
    ...apiRoutes,
  },
  fetch(request) {
    const url = new URL(request.url)
    const destination = Object.hasOwn(pageRedirects, url.pathname) ? pageRedirects[url.pathname] : undefined
    if (destination && (request.method === "GET" || request.method === "HEAD")) return Response.redirect(new URL(destination, url), 307)
    // Only registered pages serve HTML. Unknown API/provider paths stay errors.
    if (destination || isPagePath(url.pathname)) return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } })
    return jsonError("Not found.", 404)
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
      await server.stop(false)
      // Stream monitoring must settle budgets before database/Redis close.
      await drainBackgroundTasks()
      await Promise.all([closeLocalDatabase(), closeLocalRedis()])
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
