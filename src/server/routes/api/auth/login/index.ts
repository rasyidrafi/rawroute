import { createSession } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { readMeta, verifyPassword } from "@/server/store"

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body) || !("password" in body) || typeof body.password !== "string" || !body.password) {
    return jsonError("Password is required.", 400)
  }
  const data = await readMeta()
  if (!verifyPassword(body.password, data.admin.passwordHash)) {
    writeLog("warn", "auth", "Admin login rejected")
    return jsonError("Invalid password.", 401)
  }
  const cookie = await createSession(request)
  writeLog("info", "auth", "Admin signed in")
  return Response.json({ ok: true, mustChangePassword: data.admin.mustChangePassword }, { headers: { "set-cookie": cookie, "cache-control": "no-store" } })
}
