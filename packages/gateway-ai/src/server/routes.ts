import { declareRoute as apiRoute } from "@rawroute/platform/contracts/http"
import * as CliproxyInstance from "./cliproxy/http"
import * as AnthropicCallback from "./routes/anthropic/callback/index"
import * as AntigravityCallback from "./routes/antigravity/callback/index"
import * as ApiAdminApiKeysByApikey from "./routes/api/admin/api-keys/by-apikey/index"
import * as ApiAdminApiKeysRotate from "./routes/api/admin/api-keys/by-apikey/rotate/index"
import * as ApiAdminApiKeys from "./routes/api/admin/api-keys/index"
import * as ApiAdminBudgetsByApikey from "./routes/api/admin/budgets/by-apikey/index"
import * as ApiAdminBudgetsBeyondLimits from "./routes/api/admin/budgets/beyond-limits/index"
import * as ApiAdminBudgetsBypass from "./routes/api/admin/budgets/bypass/index"
import * as ApiAdminBudgets from "./routes/api/admin/budgets/index"
import * as ApiAdminBudgetsUnlimited from "./routes/api/admin/budgets/unlimited/index"
import * as ApiAdminBudgetsWindow from "./routes/api/admin/budgets/window/index"
import * as ApiAdminCombosByCombo from "./routes/api/admin/combos/by-combo/index"
import * as ApiAdminCombos from "./routes/api/admin/combos/index"
import * as ApiAdminCombosTest from "./routes/api/admin/combos/test/index"
import * as ApiAdminEndpointKey from "./routes/api/admin/endpoint-key/index"
import * as ApiAdminLimits from "./routes/api/admin/limits/index"
import * as ApiAdminModelPricingJobsByJob from "./routes/api/admin/model-pricing/jobs/by-job/index"
import * as ApiAdminModelPricingModels from "./routes/api/admin/model-pricing/models/index"
import * as ApiAdminModelPricing from "./routes/api/admin/model-pricing/index"
import * as ApiAdminModelShares from "./routes/api/admin/model-shares/index"
import * as ApiAdminOauthProvidersByAccountReset from "./routes/api/admin/oauth-providers/by-account/reset/index"
import * as ApiAdminOauthProvidersByAccount from "./routes/api/admin/oauth-providers/by-account/index"
import * as ApiAdminOauthProvidersAutoRedeem from "./routes/api/admin/oauth-providers/auto-redeem/index"
import * as ApiAdminOauthProvidersCodexDeviceCallback from "./routes/api/admin/oauth-providers/codex/device/callback/index"
import * as ApiAdminOauthProvidersCodexDeviceCancel from "./routes/api/admin/oauth-providers/codex/device/cancel/index"
import * as ApiAdminOauthProvidersCodexDevicePoll from "./routes/api/admin/oauth-providers/codex/device/poll/index"
import * as ApiAdminOauthProvidersCodexDeviceStart from "./routes/api/admin/oauth-providers/codex/device/start/index"
import * as ApiAdminOauthProviders from "./routes/api/admin/oauth-providers/index"
import * as ApiAdminOauthProvidersUsage from "./routes/api/admin/oauth-providers/usage/index"
import * as ApiAdminProvidersByProviderApiKeysByApikey from "./routes/api/admin/providers/by-provider/api-keys/by-apikey/index"
import * as ApiAdminProvidersByProviderApiKeysReorder from "./routes/api/admin/providers/by-provider/api-keys/reorder/index"
import * as ApiAdminProvidersByProviderApiKeys from "./routes/api/admin/providers/by-provider/api-keys/index"
import * as ApiAdminProvidersByProviderModelsByModel from "./routes/api/admin/providers/by-provider/models/by-model/index"
import * as ApiAdminProvidersByProviderModelsRefresh from "./routes/api/admin/providers/by-provider/models/refresh/index"
import * as ApiAdminProvidersByProviderModels from "./routes/api/admin/providers/by-provider/models/index"
import * as ApiAdminProvidersByProvider from "./routes/api/admin/providers/by-provider/index"
import * as ApiAdminProviders from "./routes/api/admin/providers/index"
import * as ApiAdminUsage from "./routes/api/admin/usage/index"
import * as ApiAdminKeyUsage from "./routes/api/admin/usage/keys/by-key/index"
import * as ApiAdminRequestLogs from "./routes/api/admin/request-logs/index"
import * as ApiAdminOverview from "./routes/api/admin/overview/index"
import * as ApiPublicDashboard from "./routes/api/public/dashboard/index"
import * as ApiPublicKeyUsage from "./routes/api/public/usage/keys/by-key/index"
import * as BackendApiCodexProxy from "./routes/backend-api/codex/proxy/index"
import * as CodexCallback from "./routes/codex/callback/index"
import * as ModelInfo from "./routes/model/info/index"
import * as OpenaiV1Proxy from "./routes/openai/v1/proxy/index"
import * as V1Proxy from "./routes/v1/proxy/index"
import * as V1ModelInfo from "./routes/v1/model/info/index"
import * as V1 from "./routes/v1/index"
import * as V1betaProxy from "./routes/v1beta/proxy/index"

export const aiServerRoutes = { id: "ai", routes: [
  apiRoute(ApiAdminRequestLogs, "workspace", "/api/admin/request-logs"),
  apiRoute(ApiAdminOverview, "workspace", "/api/admin/overview"),
  apiRoute({ GET: CliproxyInstance.status }, "session", "/api/admin/cliproxy/status"),
  apiRoute({ GET: CliproxyInstance.versions }, "session", "/api/admin/cliproxy/versions", { idleTimeout: 0 }),
  apiRoute({ POST: CliproxyInstance.lifecycle }, "session", "/api/admin/cliproxy/service/:action", { idleTimeout: 0 }),
  apiRoute(AnthropicCallback, "public", "/anthropic/callback"),
  apiRoute(AntigravityCallback, "public", "/antigravity/callback"),
  apiRoute(ApiAdminApiKeysByApikey, "workspace", "/api/admin/api-keys/:apiKeyId"),
  apiRoute(ApiAdminApiKeysRotate, "workspace", "/api/admin/api-keys/:apiKeyId/rotate"),
  apiRoute(ApiAdminApiKeys, "workspace", "/api/admin/api-keys"),
  apiRoute(ApiAdminBudgetsByApikey, "workspace", "/api/admin/budgets/:apiKeyId"),
  apiRoute(ApiAdminBudgetsBeyondLimits, "workspace", "/api/admin/budgets/beyond-limits"),
  apiRoute(ApiAdminBudgetsBypass, "workspace", "/api/admin/budgets/bypass"),
  apiRoute(ApiAdminBudgets, "workspace", "/api/admin/budgets"),
  apiRoute(ApiAdminBudgetsUnlimited, "workspace", "/api/admin/budgets/unlimited"),
  apiRoute(ApiAdminBudgetsWindow, "workspace", "/api/admin/budgets/window"),
  apiRoute(ApiAdminCombosByCombo, "workspace", "/api/admin/combos/:comboId"),
  apiRoute(ApiAdminCombos, "workspace", "/api/admin/combos"),
  apiRoute(ApiAdminCombosTest, "workspace", "/api/admin/combos/test"),
  apiRoute(ApiAdminEndpointKey, "workspace", "/api/admin/endpoint-key"),
  apiRoute(ApiAdminLimits, "workspace", "/api/admin/limits"),
  apiRoute(ApiAdminModelPricingJobsByJob, "workspace", "/api/admin/model-pricing/jobs/:jobId"),
  apiRoute(ApiAdminModelPricingModels, "workspace", "/api/admin/model-pricing/models"),
  apiRoute(ApiAdminModelPricing, "workspace", "/api/admin/model-pricing"),
  apiRoute(ApiAdminModelShares, "workspace", "/api/admin/model-shares"),
  apiRoute(ApiAdminOauthProvidersByAccountReset, "workspace", "/api/admin/oauth-providers/:accountId/reset"),
  apiRoute(ApiAdminOauthProvidersAutoRedeem, "workspace", "/api/admin/oauth-providers/auto-redeem/settings"),
  apiRoute(ApiAdminOauthProvidersByAccount, "workspace", "/api/admin/oauth-providers/:accountId"),
  apiRoute(ApiAdminOauthProvidersCodexDeviceCallback, "workspace", "/api/admin/oauth-providers/codex/device/callback"),
  apiRoute(ApiAdminOauthProvidersCodexDeviceCancel, "workspace", "/api/admin/oauth-providers/codex/device/cancel"),
  apiRoute(ApiAdminOauthProvidersCodexDevicePoll, "workspace", "/api/admin/oauth-providers/codex/device/poll"),
  apiRoute(ApiAdminOauthProvidersCodexDeviceStart, "workspace", "/api/admin/oauth-providers/codex/device/start"),
  apiRoute(ApiAdminOauthProviders, "workspace", "/api/admin/oauth-providers"),
  apiRoute(ApiAdminOauthProvidersUsage, "workspace", "/api/admin/oauth-providers/usage"),
  apiRoute(ApiAdminProvidersByProviderApiKeysByApikey, "workspace", "/api/admin/providers/:providerId/api-keys/:apiKeyId"),
  apiRoute(ApiAdminProvidersByProviderApiKeysReorder, "workspace", "/api/admin/providers/:providerId/api-keys/reorder"),
  apiRoute(ApiAdminProvidersByProviderApiKeys, "workspace", "/api/admin/providers/:providerId/api-keys"),
  apiRoute(ApiAdminProvidersByProviderModelsByModel, "workspace", "/api/admin/providers/:providerId/models/:modelId"),
  apiRoute(ApiAdminProvidersByProviderModelsRefresh, "workspace", "/api/admin/providers/:providerId/models/refresh"),
  apiRoute(ApiAdminProvidersByProviderModels, "workspace", "/api/admin/providers/:providerId/models"),
  apiRoute(ApiAdminProvidersByProvider, "workspace", "/api/admin/providers/:providerId"),
  apiRoute(ApiAdminProviders, "workspace", "/api/admin/providers"),
  apiRoute(ApiAdminUsage, "workspace", "/api/admin/usage"),
  apiRoute(ApiAdminKeyUsage, "workspace", "/api/admin/usage/keys/:keyId"),
  apiRoute(ApiPublicDashboard, "public", "/api/public/dashboard"),
  apiRoute(ApiPublicKeyUsage, "public", "/api/public/usage/keys/:keyId"),
  apiRoute(BackendApiCodexProxy, "gateway", "/backend-api/codex/*"),
  apiRoute(CodexCallback, "public", "/codex/callback"),
  apiRoute(ModelInfo, "public", "/model/info"),
  apiRoute(OpenaiV1Proxy, "gateway", "/openai/v1/*"),
  apiRoute(V1Proxy, "gateway", "/v1/*"),
  apiRoute(V1ModelInfo, "public", "/v1/model/info"),
  apiRoute(V1, "public", "/v1"),
  apiRoute(V1betaProxy, "gateway", "/v1beta/*"),
] }
