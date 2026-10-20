import { declareRoute as apiRoute } from "@rawroute/platform/contracts/http"
import * as ApiAdminToolGatewayStatus from "./routes/api/admin/tool-gateway/status/index"
import * as ExecutorApiProxy from "./routes/executor/api/proxy/index"
import * as ExecutorApi from "./routes/executor/api/index"

export const toolsServerRoutes = { id: "tools", routes: [
  apiRoute(ApiAdminToolGatewayStatus, "session", "/api/admin/tool-gateway/status"),
  apiRoute(ExecutorApiProxy, "gateway", "/executor/api/*"),
  apiRoute(ExecutorApi, "gateway", "/executor/api"),
] }
