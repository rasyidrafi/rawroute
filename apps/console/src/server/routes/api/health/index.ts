import { storageServer } from "@rawroute/gateway-storage/server/integration"
import { localDatabaseHealth } from "@rawroute/platform/server/database"
import { isMemoryBackend } from "@rawroute/platform/server/storage-config"

export async function GET() {
  const database = isMemoryBackend() ? true : await localDatabaseHealth()
  const storage = storageServer.health()
  const ok = database && (!storage.enabled || storage.listening)
  return Response.json({
    status: ok ? "ok" : "degraded",
    service: "rawroute",
    dependencies: { database, storage },
  }, { status: ok ? 200 : 503 })
}
