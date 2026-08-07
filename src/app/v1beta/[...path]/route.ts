import { proxyGatewayRequest } from "@/lib/cliproxy"

type Context = { params: Promise<{ path: string[] }> }

async function forward(request: Request, context: Context) {
  const { path } = await context.params
  return proxyGatewayRequest(request, `/v1beta/${path.join("/")}`)
}

export const GET = forward
export const POST = forward
export const PUT = forward
export const PATCH = forward
export const DELETE = forward
export const OPTIONS = forward
export const HEAD = forward

