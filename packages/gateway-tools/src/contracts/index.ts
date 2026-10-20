export type ToolGatewayState = "available" | "unavailable" | "disabled"

export interface ToolGatewayStatus {
  state: ToolGatewayState
}

export { toolPages, toolPagePaths } from "./pages"
