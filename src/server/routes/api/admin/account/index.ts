import { readMeta } from "@/lib/store"

export async function GET() {
  const meta = await readMeta()
  return Response.json({
    username: meta.admin.username,
    mustChangePassword: meta.admin.mustChangePassword,
  })
}
