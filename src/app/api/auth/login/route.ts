import { createSession } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { readData, verifyPassword } from "@/lib/store"

export const runtime = "nodejs"

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { username?: string; password?: string } | null
  if (!body?.username || !body.password) return jsonError("Username and password are required.", 400)
  const data = await readData()
  if (body.username !== data.admin.username || !verifyPassword(body.password, data.admin.passwordHash)) {
    return jsonError("Invalid username or password.", 401)
  }
  await createSession()
  return Response.json({ ok: true, mustChangePassword: data.admin.mustChangePassword })
}
