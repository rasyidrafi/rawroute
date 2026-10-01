import * as AuthBootstrap from "./routes/api/auth/bootstrap"
import * as CliproxyInstance from "./cliproxy/http"
import * as ApiAdminGlobalLogs from "./routes/api/admin/logs/global"
import * as ApiAdminLogEvents from "./routes/api/admin/logs/events"
import { apiRoute } from "./http"
import * as AnthropicCallback from "./routes/anthropic/callback"
import * as AntigravityCallback from "./routes/antigravity/callback"
import * as ApiAdminAccountPassword from "./routes/api/admin/account/password"
import * as ApiAdminAccount from "./routes/api/admin/account"
import * as ApiAdminAliasesByAlias from "./routes/api/admin/aliases/by-alias"
import * as ApiAdminAliases from "./routes/api/admin/aliases"
import * as ApiAdminApiKeysByApikey from "./routes/api/admin/api-keys/by-apikey"
import * as ApiAdminApiKeys from "./routes/api/admin/api-keys"
import * as ApiAdminBudgetsByApikey from "./routes/api/admin/budgets/by-apikey"
import * as ApiAdminBudgetsBeyondLimits from "./routes/api/admin/budgets/beyond-limits"
import * as ApiAdminBudgetsBypass from "./routes/api/admin/budgets/bypass"
import * as ApiAdminBudgets from "./routes/api/admin/budgets"
import * as ApiAdminBudgetsUnlimited from "./routes/api/admin/budgets/unlimited"
import * as ApiAdminBudgetsWindow from "./routes/api/admin/budgets/window"
import * as ApiAdminCombosByCombo from "./routes/api/admin/combos/by-combo"
import * as ApiAdminCombos from "./routes/api/admin/combos"
import * as ApiAdminCombosTest from "./routes/api/admin/combos/test"
import * as ApiAdminEndpointKey from "./routes/api/admin/endpoint-key"
import * as ApiAdminLimits from "./routes/api/admin/limits"
import * as ApiAdminLogs from "./routes/api/admin/logs"
import * as ApiAdminModelPricingJobsByJob from "./routes/api/admin/model-pricing/jobs/by-job"
import * as ApiAdminModelPricingModels from "./routes/api/admin/model-pricing/models"
import * as ApiAdminModelPricing from "./routes/api/admin/model-pricing"
import * as ApiAdminModelShares from "./routes/api/admin/model-shares"
import * as ApiAdminOauthProvidersByAccountReset from "./routes/api/admin/oauth-providers/by-account/reset"
import * as ApiAdminOauthProvidersByAccount from "./routes/api/admin/oauth-providers/by-account"
import * as ApiAdminOauthProvidersCodexDeviceCallback from "./routes/api/admin/oauth-providers/codex/device/callback"
import * as ApiAdminOauthProvidersCodexDeviceCancel from "./routes/api/admin/oauth-providers/codex/device/cancel"
import * as ApiAdminOauthProvidersCodexDevicePoll from "./routes/api/admin/oauth-providers/codex/device/poll"
import * as ApiAdminOauthProvidersCodexDeviceStart from "./routes/api/admin/oauth-providers/codex/device/start"
import * as ApiAdminOauthProviders from "./routes/api/admin/oauth-providers"
import * as ApiAdminOauthProvidersUsage from "./routes/api/admin/oauth-providers/usage"
import * as ApiAdminProvidersByProviderApiKeysByApikey from "./routes/api/admin/providers/by-provider/api-keys/by-apikey"
import * as ApiAdminProvidersByProviderApiKeysReorder from "./routes/api/admin/providers/by-provider/api-keys/reorder"
import * as ApiAdminProvidersByProviderApiKeys from "./routes/api/admin/providers/by-provider/api-keys"
import * as ApiAdminProvidersByProviderModelsByModel from "./routes/api/admin/providers/by-provider/models/by-model"
import * as ApiAdminProvidersByProviderModelsRefresh from "./routes/api/admin/providers/by-provider/models/refresh"
import * as ApiAdminProvidersByProviderModels from "./routes/api/admin/providers/by-provider/models"
import * as ApiAdminProvidersByProvider from "./routes/api/admin/providers/by-provider"
import * as ApiAdminProviders from "./routes/api/admin/providers"
import * as ApiAdminToolGatewayStatus from "./routes/api/admin/tool-gateway/status"
import * as ApiAdminUsage from "./routes/api/admin/usage"
import * as ApiAdminWorkspacesByWorkspace from "./routes/api/admin/workspaces/by-workspace"
import * as ApiAdminWorkspaces from "./routes/api/admin/workspaces"
import * as ApiAuthLogin from "./routes/api/auth/login"
import * as ApiAuthLogout from "./routes/api/auth/logout"
import * as ApiAuthSession from "./routes/api/auth/session"
import * as ApiConfig from "./routes/api/config"
import * as ApiHealth from "./routes/api/health"
import * as ApiPublicDashboard from "./routes/api/public/dashboard"
import * as ApiPublicWorkspaces from "./routes/api/public/workspaces"
import * as BackendApiCodexProxy from "./routes/backend-api/codex/proxy"
import * as CodexCallback from "./routes/codex/callback"
import * as ExecutorApiProxy from "./routes/executor/api/proxy"
import * as ExecutorApi from "./routes/executor/api"
import * as ModelInfo from "./routes/model/info"
import * as OpenaiV1Proxy from "./routes/openai/v1/proxy"
import * as V1Proxy from "./routes/v1/proxy"
import * as V1ModelInfo from "./routes/v1/model/info"
import * as V1 from "./routes/v1"
import * as V1betaProxy from "./routes/v1beta/proxy"

export const apiRoutes = {
  "/api/auth/bootstrap": apiRoute(AuthBootstrap, "public", "/api/auth/bootstrap"),
  "/api/live": apiRoute({ GET: async () => Response.json({ status: "ok", service: "rawroute" }) }, "public", "/api/live"),
  "/api/admin/cliproxy/status": apiRoute({ GET: CliproxyInstance.status }, "session", "/api/admin/cliproxy/status"),
  "/api/admin/cliproxy/versions": apiRoute({ GET: CliproxyInstance.versions }, "session", "/api/admin/cliproxy/versions"),
  "/api/admin/cliproxy/service/:action": apiRoute({ POST: CliproxyInstance.lifecycle }, "session", "/api/admin/cliproxy/service/:action"),
  "/anthropic/callback": apiRoute(AnthropicCallback, "public", "/anthropic/callback"),
  "/antigravity/callback": apiRoute(AntigravityCallback, "public", "/antigravity/callback"),
  "/api/admin/account/password": apiRoute(ApiAdminAccountPassword, "session", "/api/admin/account/password"),
  "/api/admin/account": apiRoute(ApiAdminAccount, "session", "/api/admin/account"),
  "/api/admin/aliases/:aliasId": apiRoute(ApiAdminAliasesByAlias, "workspace", "/api/admin/aliases/:aliasId"),
  "/api/admin/aliases": apiRoute(ApiAdminAliases, "workspace", "/api/admin/aliases"),
  "/api/admin/api-keys/:apiKeyId": apiRoute(ApiAdminApiKeysByApikey, "workspace", "/api/admin/api-keys/:apiKeyId"),
  "/api/admin/api-keys": apiRoute(ApiAdminApiKeys, "workspace", "/api/admin/api-keys"),
  "/api/admin/budgets/:apiKeyId": apiRoute(ApiAdminBudgetsByApikey, "workspace", "/api/admin/budgets/:apiKeyId"),
  "/api/admin/budgets/beyond-limits": apiRoute(ApiAdminBudgetsBeyondLimits, "workspace", "/api/admin/budgets/beyond-limits"),
  "/api/admin/budgets/bypass": apiRoute(ApiAdminBudgetsBypass, "workspace", "/api/admin/budgets/bypass"),
  "/api/admin/budgets": apiRoute(ApiAdminBudgets, "workspace", "/api/admin/budgets"),
  "/api/admin/budgets/unlimited": apiRoute(ApiAdminBudgetsUnlimited, "workspace", "/api/admin/budgets/unlimited"),
  "/api/admin/budgets/window": apiRoute(ApiAdminBudgetsWindow, "workspace", "/api/admin/budgets/window"),
  "/api/admin/combos/:comboId": apiRoute(ApiAdminCombosByCombo, "workspace", "/api/admin/combos/:comboId"),
  "/api/admin/combos": apiRoute(ApiAdminCombos, "workspace", "/api/admin/combos"),
  "/api/admin/combos/test": apiRoute(ApiAdminCombosTest, "workspace", "/api/admin/combos/test"),
  "/api/admin/endpoint-key": apiRoute(ApiAdminEndpointKey, "workspace", "/api/admin/endpoint-key"),
  "/api/admin/limits": apiRoute(ApiAdminLimits, "workspace", "/api/admin/limits"),
  "/api/admin/logs/global": apiRoute(ApiAdminGlobalLogs, "session", "/api/admin/logs/global"),
  "/api/admin/logs/events": apiRoute(ApiAdminLogEvents, "session", "/api/admin/logs/events"),
  "/api/admin/logs": apiRoute(ApiAdminLogs, "explicit-workspace", "/api/admin/logs"),
  "/api/admin/model-pricing/jobs/:jobId": apiRoute(ApiAdminModelPricingJobsByJob, "workspace", "/api/admin/model-pricing/jobs/:jobId"),
  "/api/admin/model-pricing/models": apiRoute(ApiAdminModelPricingModels, "workspace", "/api/admin/model-pricing/models"),
  "/api/admin/model-pricing": apiRoute(ApiAdminModelPricing, "workspace", "/api/admin/model-pricing"),
  "/api/admin/model-shares": apiRoute(ApiAdminModelShares, "workspace", "/api/admin/model-shares"),
  "/api/admin/oauth-providers/:accountId/reset": apiRoute(ApiAdminOauthProvidersByAccountReset, "workspace", "/api/admin/oauth-providers/:accountId/reset"),
  "/api/admin/oauth-providers/:accountId": apiRoute(ApiAdminOauthProvidersByAccount, "workspace", "/api/admin/oauth-providers/:accountId"),
  "/api/admin/oauth-providers/codex/device/callback": apiRoute(ApiAdminOauthProvidersCodexDeviceCallback, "workspace", "/api/admin/oauth-providers/codex/device/callback"),
  "/api/admin/oauth-providers/codex/device/cancel": apiRoute(ApiAdminOauthProvidersCodexDeviceCancel, "workspace", "/api/admin/oauth-providers/codex/device/cancel"),
  "/api/admin/oauth-providers/codex/device/poll": apiRoute(ApiAdminOauthProvidersCodexDevicePoll, "workspace", "/api/admin/oauth-providers/codex/device/poll"),
  "/api/admin/oauth-providers/codex/device/start": apiRoute(ApiAdminOauthProvidersCodexDeviceStart, "workspace", "/api/admin/oauth-providers/codex/device/start"),
  "/api/admin/oauth-providers": apiRoute(ApiAdminOauthProviders, "workspace", "/api/admin/oauth-providers"),
  "/api/admin/oauth-providers/usage": apiRoute(ApiAdminOauthProvidersUsage, "workspace", "/api/admin/oauth-providers/usage"),
  "/api/admin/providers/:providerId/api-keys/:apiKeyId": apiRoute(ApiAdminProvidersByProviderApiKeysByApikey, "workspace", "/api/admin/providers/:providerId/api-keys/:apiKeyId"),
  "/api/admin/providers/:providerId/api-keys/reorder": apiRoute(ApiAdminProvidersByProviderApiKeysReorder, "workspace", "/api/admin/providers/:providerId/api-keys/reorder"),
  "/api/admin/providers/:providerId/api-keys": apiRoute(ApiAdminProvidersByProviderApiKeys, "workspace", "/api/admin/providers/:providerId/api-keys"),
  "/api/admin/providers/:providerId/models/:modelId": apiRoute(ApiAdminProvidersByProviderModelsByModel, "workspace", "/api/admin/providers/:providerId/models/:modelId"),
  "/api/admin/providers/:providerId/models/refresh": apiRoute(ApiAdminProvidersByProviderModelsRefresh, "workspace", "/api/admin/providers/:providerId/models/refresh"),
  "/api/admin/providers/:providerId/models": apiRoute(ApiAdminProvidersByProviderModels, "workspace", "/api/admin/providers/:providerId/models"),
  "/api/admin/providers/:providerId": apiRoute(ApiAdminProvidersByProvider, "workspace", "/api/admin/providers/:providerId"),
  "/api/admin/providers": apiRoute(ApiAdminProviders, "workspace", "/api/admin/providers"),
  "/api/admin/tool-gateway/status": apiRoute(ApiAdminToolGatewayStatus, "session", "/api/admin/tool-gateway/status"),
  "/api/admin/usage": apiRoute(ApiAdminUsage, "workspace", "/api/admin/usage"),
  "/api/admin/workspaces/:workspaceId": apiRoute(ApiAdminWorkspacesByWorkspace, "session", "/api/admin/workspaces/:workspaceId"),
  "/api/admin/workspaces": apiRoute(ApiAdminWorkspaces, "session", "/api/admin/workspaces"),
  "/api/auth/login": apiRoute(ApiAuthLogin, "public", "/api/auth/login"),
  "/api/auth/logout": apiRoute(ApiAuthLogout, "public", "/api/auth/logout"),
  "/api/auth/session": apiRoute(ApiAuthSession, "public", "/api/auth/session"),
  "/api/config": apiRoute(ApiConfig, "public", "/api/config"),
  "/api/health": apiRoute(ApiHealth, "public", "/api/health"),
  "/api/public/dashboard": apiRoute(ApiPublicDashboard, "public", "/api/public/dashboard"),
  "/api/public/workspaces": apiRoute(ApiPublicWorkspaces, "public", "/api/public/workspaces"),
  "/backend-api/codex/*": apiRoute(BackendApiCodexProxy, "gateway", "/backend-api/codex/*"),
  "/codex/callback": apiRoute(CodexCallback, "public", "/codex/callback"),
  "/executor/api/*": apiRoute(ExecutorApiProxy, "gateway", "/executor/api/*"),
  "/executor/api": apiRoute(ExecutorApi, "gateway", "/executor/api"),
  "/model/info": apiRoute(ModelInfo, "public", "/model/info"),
  "/openai/v1/*": apiRoute(OpenaiV1Proxy, "gateway", "/openai/v1/*"),
  "/v1/*": apiRoute(V1Proxy, "gateway", "/v1/*"),
  "/v1/model/info": apiRoute(V1ModelInfo, "public", "/v1/model/info"),
  "/v1": apiRoute(V1, "public", "/v1"),
  "/v1beta/*": apiRoute(V1betaProxy, "gateway", "/v1beta/*"),
}
