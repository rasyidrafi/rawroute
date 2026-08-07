import { cliProxyHealth } from "@/lib/cliproxy"

export async function GET() {
  const cliproxy = await cliProxyHealth()
  return Response.json({ status: cliproxy ? "ok" : "degraded", service: "rawroute", cliproxy }, { status: cliproxy ? 200 : 503 })
}

