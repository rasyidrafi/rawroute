import { proxyRequest } from "@/lib/proxy"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  return proxyRequest(request, "openai-responses")
}
