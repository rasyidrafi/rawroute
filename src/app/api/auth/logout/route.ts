import { destroySession } from "@/lib/auth"
import { writeLog } from "@/lib/logger"

export async function POST() {
  await destroySession()
  writeLog("info", "auth", "Admin signed out")
  return Response.json({ ok: true })
}
