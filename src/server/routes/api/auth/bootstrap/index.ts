import { DEFAULT_ADMIN_PASSWORD, isLocalLoginHost, type BootstrapStatus } from "@/lib/auth-defaults"
import { readMeta, verifyPassword } from "@/server/store"

export async function GET(request: Request) {
  const { admin } = await readMeta()
  // Only the documented, public default may be disclosed, never an environment secret.
  const showHint = admin.mustChangePassword && isLocalLoginHost(new URL(request.url).hostname)
    && process.env.AUTH_SHOW_DEFAULT_PASSWORD_HINT !== "false"
    && verifyPassword(DEFAULT_ADMIN_PASSWORD, admin.passwordHash)
  return Response.json({ isDefaultPassword: admin.mustChangePassword, defaultPasswordHint: showHint ? DEFAULT_ADMIN_PASSWORD : null } satisfies BootstrapStatus, {
    headers: { "cache-control": "private, no-store" },
  })
}
