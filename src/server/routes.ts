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
import * as ApiAdminCliproxyApiKeys from "./routes/api/admin/cliproxy/api-keys"
import * as ApiAdminCliproxyAuthFiles from "./routes/api/admin/cliproxy/auth-files"
import * as ApiAdminCliproxyLogs from "./routes/api/admin/cliproxy/logs"
import * as ApiAdminCliproxyOauthByProviderStart from "./routes/api/admin/cliproxy/oauth/by-provider/start"
import * as ApiAdminCliproxyOauthCancel from "./routes/api/admin/cliproxy/oauth/cancel"
import * as ApiAdminCliproxyOauthStatus from "./routes/api/admin/cliproxy/oauth/status"
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
import * as ApiAdminSettings from "./routes/api/admin/settings"
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
  "/anthropic/callback": apiRoute(AnthropicCallback, "public"),
  "/antigravity/callback": apiRoute(AntigravityCallback, "public"),
  "/api/admin/account/password": apiRoute(ApiAdminAccountPassword, "workspace"),
  "/api/admin/account": apiRoute(ApiAdminAccount, "workspace"),
  "/api/admin/aliases/:aliasId": apiRoute(ApiAdminAliasesByAlias, "workspace"),
  "/api/admin/aliases": apiRoute(ApiAdminAliases, "workspace"),
  "/api/admin/api-keys/:apiKeyId": apiRoute(ApiAdminApiKeysByApikey, "workspace"),
  "/api/admin/api-keys": apiRoute(ApiAdminApiKeys, "workspace"),
  "/api/admin/budgets/:apiKeyId": apiRoute(ApiAdminBudgetsByApikey, "workspace"),
  "/api/admin/budgets/beyond-limits": apiRoute(ApiAdminBudgetsBeyondLimits, "workspace"),
  "/api/admin/budgets/bypass": apiRoute(ApiAdminBudgetsBypass, "workspace"),
  "/api/admin/budgets": apiRoute(ApiAdminBudgets, "workspace"),
  "/api/admin/budgets/unlimited": apiRoute(ApiAdminBudgetsUnlimited, "workspace"),
  "/api/admin/budgets/window": apiRoute(ApiAdminBudgetsWindow, "workspace"),
  "/api/admin/cliproxy/api-keys": apiRoute(ApiAdminCliproxyApiKeys, "session"),
  "/api/admin/cliproxy/auth-files": apiRoute(ApiAdminCliproxyAuthFiles, "session"),
  "/api/admin/cliproxy/logs": apiRoute(ApiAdminCliproxyLogs, "session"),
  "/api/admin/cliproxy/oauth/:provider/start": apiRoute(ApiAdminCliproxyOauthByProviderStart, "session"),
  "/api/admin/cliproxy/oauth/cancel": apiRoute(ApiAdminCliproxyOauthCancel, "session"),
  "/api/admin/cliproxy/oauth/status": apiRoute(ApiAdminCliproxyOauthStatus, "session"),
  "/api/admin/combos/:comboId": apiRoute(ApiAdminCombosByCombo, "workspace"),
  "/api/admin/combos": apiRoute(ApiAdminCombos, "workspace"),
  "/api/admin/combos/test": apiRoute(ApiAdminCombosTest, "workspace"),
  "/api/admin/endpoint-key": apiRoute(ApiAdminEndpointKey, "workspace"),
  "/api/admin/limits": apiRoute(ApiAdminLimits, "workspace"),
  "/api/admin/logs": apiRoute(ApiAdminLogs, "explicit-workspace"),
  "/api/admin/model-pricing/jobs/:jobId": apiRoute(ApiAdminModelPricingJobsByJob, "workspace"),
  "/api/admin/model-pricing/models": apiRoute(ApiAdminModelPricingModels, "workspace"),
  "/api/admin/model-pricing": apiRoute(ApiAdminModelPricing, "workspace"),
  "/api/admin/model-shares": apiRoute(ApiAdminModelShares, "workspace"),
  "/api/admin/oauth-providers/:accountId/reset": apiRoute(ApiAdminOauthProvidersByAccountReset, "workspace"),
  "/api/admin/oauth-providers/:accountId": apiRoute(ApiAdminOauthProvidersByAccount, "workspace"),
  "/api/admin/oauth-providers/codex/device/callback": apiRoute(ApiAdminOauthProvidersCodexDeviceCallback, "workspace"),
  "/api/admin/oauth-providers/codex/device/cancel": apiRoute(ApiAdminOauthProvidersCodexDeviceCancel, "workspace"),
  "/api/admin/oauth-providers/codex/device/poll": apiRoute(ApiAdminOauthProvidersCodexDevicePoll, "workspace"),
  "/api/admin/oauth-providers/codex/device/start": apiRoute(ApiAdminOauthProvidersCodexDeviceStart, "workspace"),
  "/api/admin/oauth-providers": apiRoute(ApiAdminOauthProviders, "workspace"),
  "/api/admin/oauth-providers/usage": apiRoute(ApiAdminOauthProvidersUsage, "workspace"),
  "/api/admin/providers/:providerId/api-keys/:apiKeyId": apiRoute(ApiAdminProvidersByProviderApiKeysByApikey, "workspace"),
  "/api/admin/providers/:providerId/api-keys/reorder": apiRoute(ApiAdminProvidersByProviderApiKeysReorder, "workspace"),
  "/api/admin/providers/:providerId/api-keys": apiRoute(ApiAdminProvidersByProviderApiKeys, "workspace"),
  "/api/admin/providers/:providerId/models/:modelId": apiRoute(ApiAdminProvidersByProviderModelsByModel, "workspace"),
  "/api/admin/providers/:providerId/models/refresh": apiRoute(ApiAdminProvidersByProviderModelsRefresh, "workspace"),
  "/api/admin/providers/:providerId/models": apiRoute(ApiAdminProvidersByProviderModels, "workspace"),
  "/api/admin/providers/:providerId": apiRoute(ApiAdminProvidersByProvider, "workspace"),
  "/api/admin/providers": apiRoute(ApiAdminProviders, "workspace"),
  "/api/admin/settings": apiRoute(ApiAdminSettings, "session"),
  "/api/admin/tool-gateway/status": apiRoute(ApiAdminToolGatewayStatus, "session"),
  "/api/admin/usage": apiRoute(ApiAdminUsage, "workspace"),
  "/api/admin/workspaces/:workspaceId": apiRoute(ApiAdminWorkspacesByWorkspace, "session"),
  "/api/admin/workspaces": apiRoute(ApiAdminWorkspaces, "session"),
  "/api/auth/login": apiRoute(ApiAuthLogin, "public"),
  "/api/auth/logout": apiRoute(ApiAuthLogout, "public"),
  "/api/auth/session": apiRoute(ApiAuthSession, "public"),
  "/api/config": apiRoute(ApiConfig, "public"),
  "/api/health": apiRoute(ApiHealth, "public"),
  "/api/public/dashboard": apiRoute(ApiPublicDashboard, "public"),
  "/api/public/workspaces": apiRoute(ApiPublicWorkspaces, "public"),
  "/backend-api/codex/*": apiRoute(BackendApiCodexProxy, "gateway"),
  "/codex/callback": apiRoute(CodexCallback, "public"),
  "/executor/api/*": apiRoute(ExecutorApiProxy, "gateway"),
  "/executor/api": apiRoute(ExecutorApi, "gateway"),
  "/model/info": apiRoute(ModelInfo, "public"),
  "/openai/v1/*": apiRoute(OpenaiV1Proxy, "gateway"),
  "/v1/*": apiRoute(V1Proxy, "gateway"),
  "/v1/model/info": apiRoute(V1ModelInfo, "public"),
  "/v1": apiRoute(V1, "public"),
  "/v1beta/*": apiRoute(V1betaProxy, "gateway"),
}
