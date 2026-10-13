import { cliProxyHealth } from "@/lib/cliproxy/gateway"
import { localDatabaseHealth } from "@/lib/local-db"

export async function GET() {
  const [cliproxy, database] = await Promise.all([
    cliProxyHealth(),
    process.env.STORAGE_BACKEND === "memory" ? Promise.resolve(true) : localDatabaseHealth(),
  ])
  const ok = cliproxy && database
  return Response.json({
    status: ok ? "ok" : "degraded",
    service: "rawroute",
    dependencies: { cliproxy, database },
  }, { status: ok ? 200 : 503 })
}
