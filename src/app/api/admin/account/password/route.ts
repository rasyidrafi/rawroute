import { requireAdmin } from "@/lib/auth"
import { jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { hashPassword, updateMeta, validatePasswordUpdate } from "@/lib/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return jsonError("Unauthorized", 401)
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError("Invalid request.", 400)

  try {
    const meta = await updateMeta(async (current) => {
      if (typeof body.password === "string" && body.password.length > 0) {
        if (body.password.length < 10) throw new Error("Password must be at least 10 characters.")
        current.admin.passwordHash = hashPassword(body.password)
        current.admin.mustChangePassword = false
        return
      }
      const currentPassword = String(body.currentPassword || "")
      const newPassword = String(body.newPassword || "")
      const confirmPassword = String(body.confirmPassword || "")
      validatePasswordUpdate(currentPassword, newPassword, confirmPassword, current.admin.passwordHash)
      current.admin.passwordHash = hashPassword(newPassword)
      current.admin.mustChangePassword = false
    })
    writeLog("info", "admin", "Password updated")
    return Response.json({ ok: true, mustChangePassword: meta.admin.mustChangePassword })
  } catch (error) {
    writeLog("error", "admin", "Password update failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update password.", 400)
  }
}