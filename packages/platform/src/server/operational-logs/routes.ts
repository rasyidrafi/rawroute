import { declareRoute as apiRoute } from "../../contracts/http"
import * as ApiAdminGlobalLogs from "./routes/api/admin/logs/global/index"
import * as ApiAdminLogEvents from "./routes/api/admin/logs/events/index"
import * as ApiAdminLogs from "./routes/api/admin/logs/index"

export const observabilityServerRoutes = { id: "observability", routes: [
  apiRoute(ApiAdminGlobalLogs, "session", "/api/admin/logs/global", { operationalLog: "omit" }),
  apiRoute(ApiAdminLogEvents, "session", "/api/admin/logs/events", { operationalLog: "omit" }),
  apiRoute(ApiAdminLogs, "explicit-workspace", "/api/admin/logs", { operationalLog: "omit" }),
] }
