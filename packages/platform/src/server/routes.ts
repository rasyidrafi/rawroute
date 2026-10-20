import { declareRoute as apiRoute } from "../contracts/http"
import * as AuthBootstrap from "./routes/api/auth/bootstrap/index"
import * as ApiAdminAccountPassword from "./routes/api/admin/account/password/index"
import * as ApiAdminAccount from "./routes/api/admin/account/index"
import * as ApiAdminWorkspacesByWorkspace from "./routes/api/admin/workspaces/by-workspace/index"
import * as ApiAdminWorkspaces from "./routes/api/admin/workspaces/index"
import * as ApiAuthLogin from "./routes/api/auth/login/index"
import * as ApiAuthLogout from "./routes/api/auth/logout/index"
import * as ApiAuthSession from "./routes/api/auth/session/index"
import * as ApiConfig from "./routes/api/config/index"
import * as ApiPublicWorkspaces from "./routes/api/public/workspaces/index"

export const platformServerRoutes = { id: "platform", routes: [
  apiRoute(AuthBootstrap, "public", "/api/auth/bootstrap"),
  apiRoute(ApiAdminAccountPassword, "session", "/api/admin/account/password", { allowInitialPassword: true }),
  apiRoute(ApiAdminAccount, "session", "/api/admin/account", { allowInitialPassword: true }),
  apiRoute(ApiAdminWorkspacesByWorkspace, "session", "/api/admin/workspaces/:workspaceId", { idleTimeout: 0, idleTimeoutMethods: ["DELETE"] }),
  apiRoute(ApiAdminWorkspaces, "session", "/api/admin/workspaces"),
  apiRoute(ApiAuthLogin, "public", "/api/auth/login"),
  apiRoute(ApiAuthLogout, "public", "/api/auth/logout"),
  apiRoute(ApiAuthSession, "public", "/api/auth/session"),
  apiRoute(ApiConfig, "public", "/api/config"),
  apiRoute(ApiPublicWorkspaces, "public", "/api/public/workspaces"),
] }
