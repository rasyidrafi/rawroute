import { lazy, type ReactElement } from "react"
import type { toolPages } from "../contracts/pages"

const ToolGatewayView = lazy(() => import("./components/tool-gateway-view").then(module => ({ default: module.ToolGatewayView })))
export const toolsViews = {
  tools: <ToolGatewayView page="overview" />,
  toolCatalog: <ToolGatewayView page="tools" />,
  toolConnections: <ToolGatewayView page="connections" />,
  toolActivity: <ToolGatewayView page="activity" />,
  toolPolicies: <ToolGatewayView page="policies" />,
  toolSettings: <ToolGatewayView page="settings" />,
} satisfies Record<keyof typeof toolPages, ReactElement>
