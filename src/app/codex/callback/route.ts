import { proxyToCliProxy } from "@/lib/cliproxy"

export async function GET(request: Request) {
  return proxyToCliProxy(request, "/codex/callback")
}

