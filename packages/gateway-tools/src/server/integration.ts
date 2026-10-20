import { proxyExecutorRequest as forward } from "./runtime"
import type { ToolGatewayDependencies } from "./contracts"

let dependencies: ToolGatewayDependencies | undefined
export function configureToolsServer(value: ToolGatewayDependencies) { dependencies = value }
export function proxyExecutorRequest(request: Request) {
  if (!dependencies) throw new Error("Tools server must be configured before use.")
  return forward(request, dependencies)
}
