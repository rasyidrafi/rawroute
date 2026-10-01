import { destroySession } from "@/lib/auth"
import { recordLog } from "@/server/logging/recorder"

export async function POST() {
  recordLog("auth.logout", {}, { level: "info" })
  return Response.json({ ok: true }, { headers: { "set-cookie": destroySession(), "cache-control": "no-store" } })
}
