import { readMeta } from "../../../../runtime"

export async function GET() {
  const meta = await readMeta()
  return Response.json({
    mustChangePassword: meta.admin.mustChangePassword,
  })
}
