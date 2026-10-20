import type { GatewayAuthentication } from "@rawroute/platform/contracts/request-identity"

type ToolGatewayEvent =
  | "gateway.executor.authentication.is.unavailable"
  | "gateway.executor.request.rejected.invalid.api.key"
  | "gateway.executor.request.rejected.invalid.path"
  | "gateway.executor.proxy.is.not.configured"
  | "gateway.executor.response.received"
  | "gateway.executor.upstream.request.failed"

export type ToolGatewayLog = (event: ToolGatewayEvent, details: Record<string, unknown>, options: { level: "info" | "warn" | "error" }) => unknown

export interface ToolGatewayDependencies {
  authenticate: GatewayAuthentication
  recordLog: ToolGatewayLog
}
