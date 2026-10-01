import { getToolGatewayStatus } from "@/lib/executor"

export async function GET() {

  return Response.json(await getToolGatewayStatus(), {
    headers: { "cache-control": "private, max-age=10, stale-while-revalidate=20" },
  })
}
