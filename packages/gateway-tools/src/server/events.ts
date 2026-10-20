export const serverEvents = {
  "gateway.executor.authentication.is.unavailable": { message: "Executor authentication is unavailable", source: "gateway" },
  "gateway.executor.request.rejected.invalid.api.key": { message: "Executor request rejected: invalid API key", source: "gateway" },
  "gateway.executor.request.rejected.invalid.path": { message: "Executor request rejected: invalid path", source: "gateway" },
  "gateway.executor.proxy.is.not.configured": { message: "Executor proxy is not configured", source: "gateway" },
  "gateway.executor.upstream.request.failed": { message: "Executor upstream request failed", source: "gateway" },
  "gateway.executor.response.received": { message: "Executor response headers received", source: "gateway" },
} as const
export type ServerEvent = keyof typeof serverEvents
