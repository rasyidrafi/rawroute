import { proxyExecutorRequest } from "@/lib/executor"

const forward = (request: Request) => proxyExecutorRequest(request)

export const GET = forward
export const POST = forward
export const PUT = forward
export const PATCH = forward
export const DELETE = forward
export const OPTIONS = forward
export const HEAD = forward
