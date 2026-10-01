import { proxyGatewayRequest } from "@/lib/cliproxy/gateway"

const forward = (request: Request) => proxyGatewayRequest(request, new URL(request.url).pathname)

export const GET = forward
export const POST = forward
export const PUT = forward
export const PATCH = forward
export const DELETE = forward
export const OPTIONS = forward
export const HEAD = forward
