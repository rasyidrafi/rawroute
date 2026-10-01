import { destroySession } from "@/lib/auth"
import { writeLog } from "@/lib/logger"

export async function POST() {
  writeLog("info", "auth", "Admin signed out")
  return Response.json({ ok: true }, { headers: { "set-cookie": destroySession(), "cache-control": "no-store" } })
}
