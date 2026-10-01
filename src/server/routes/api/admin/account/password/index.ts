import { jsonError } from "@/lib/http"
import { recordLog } from "@/server/logging/recorder"
import { hashPassword, updateMeta, validatePasswordUpdate } from "@/server/store"

export async function POST(request: Request) {
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
    recordLog("auth.password.changed", {}, { level: "info" })
    return Response.json({ ok: true, mustChangePassword: meta.admin.mustChangePassword })
  } catch (error) {
    recordLog("auth.password.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to update password.", 400)
  }
}
