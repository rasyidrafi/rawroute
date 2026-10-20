import "./composition"
import { declareRoute } from "@rawroute/platform/contracts/http"
import { composeServerRoutes } from "./route-composition"
import { platformServerRoutes } from "@rawroute/platform/server/routes"
import { aiServerRoutes } from "@rawroute/gateway-ai/server/routes"
import { toolsServerRoutes } from "@rawroute/gateway-tools/server/routes"
import { observabilityServerRoutes } from "@rawroute/platform/server/operational-logs/routes"
import * as ApiHealth from "./routes/api/health/index"

export const serverRouteContributions = [
  platformServerRoutes, aiServerRoutes, toolsServerRoutes, observabilityServerRoutes,
  { id: "console", routes: [
    declareRoute({ GET: async () => Response.json({ status: "ok", service: "rawroute" }) }, "public", "/api/live"),
    declareRoute(ApiHealth, "public", "/api/health"),
  ] },
]
export const apiRoutes = composeServerRoutes(serverRouteContributions)
