import { isAuthenticated } from "@/lib/auth"
import { getToolGatewayStatus } from "@/lib/executor"
import { jsonError } from "@/lib/http"

export const runtime = "nodejs"

export async function GET() {
  if (!(await isAuthenticated())) return jsonError("Unauthorized", 401)

  return Response.json(await getToolGatewayStatus(), {
    headers: { "cache-control": "private, max-age=10, stale-while-revalidate=20" },
  })
}
