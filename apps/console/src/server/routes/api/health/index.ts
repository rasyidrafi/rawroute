import { aiServer } from "@rawroute/gateway-ai/server/integration"
import { localDatabaseHealth } from "@rawroute/platform/server/database"

export async function GET() {
  const [cliproxy, database] = await Promise.all([
    aiServer.health(),
    process.env.STORAGE_BACKEND === "memory" ? Promise.resolve(true) : localDatabaseHealth(),
  ])
  const ok = cliproxy && database
  return Response.json({
    status: ok ? "ok" : "degraded",
    service: "rawroute",
    dependencies: { cliproxy, database },
  }, { status: ok ? 200 : 503 })
}
