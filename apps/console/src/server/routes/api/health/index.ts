import { aiServer } from "@rawroute/gateway-ai/server/integration"
import { storageServer } from "@rawroute/gateway-storage/server/integration"
import { localDatabaseHealth } from "@rawroute/platform/server/database"
import { isMemoryBackend } from "@rawroute/platform/server/storage-config"

export async function GET() {
  const [cliproxy, database] = await Promise.all([
    aiServer.health(),
    isMemoryBackend() ? Promise.resolve(true) : localDatabaseHealth(),
  ])
  const storage = storageServer.health()
  const ok = cliproxy && database && (!storage.enabled || storage.listening)
  return Response.json({
    status: ok ? "ok" : "degraded",
    service: "rawroute",
    dependencies: { cliproxy, database, storage },
  }, { status: ok ? 200 : 503 })
}
