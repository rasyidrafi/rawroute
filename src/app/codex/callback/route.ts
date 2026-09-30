import { proxyToCliProxy } from "@/lib/cliproxy/gateway"

export async function GET(request: Request) {
  return proxyToCliProxy(request, "/codex/callback")
}
