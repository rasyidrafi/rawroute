import { cliProxyHealth } from "@/lib/cliproxy"
import { localDatabaseHealth } from "@/lib/local-db"
import { localRedisHealth } from "@/lib/local-redis"

export const runtime = "nodejs"

export async function GET() {
  const [cliproxy, database, redis] = await Promise.all([
    cliProxyHealth(),
    process.env.STORAGE_BACKEND === "memory" ? Promise.resolve(true) : localDatabaseHealth(),
    process.env.STORAGE_BACKEND === "memory" ? Promise.resolve(true) : localRedisHealth(),
  ])
  const ok = cliproxy && database && redis
  return Response.json({
    status: ok ? "ok" : "degraded",
    service: "rawroute",
    dependencies: { cliproxy, database, redis },
  }, { status: ok ? 200 : 503 })
}
