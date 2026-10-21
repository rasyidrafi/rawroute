import { DEFAULT_ADMIN_PASSWORD, type BootstrapStatus } from "../../../../../contracts/auth-defaults"
import { readMeta } from "../../../../runtime"
import { verifyPassword } from "../../../../identity"

export async function GET() {
  const { admin } = await readMeta()
  // Only the public default may be disclosed, never a saved private password.
  const showHint = admin.mustChangePassword
    && verifyPassword(DEFAULT_ADMIN_PASSWORD, admin.passwordHash)
  return Response.json({ isDefaultPassword: admin.mustChangePassword, defaultPasswordHint: showHint ? DEFAULT_ADMIN_PASSWORD : null } satisfies BootstrapStatus, {
    headers: { "cache-control": "private, no-store" },
  })
}
