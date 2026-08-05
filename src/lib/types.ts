export type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages"

export type AuthType = "bearer" | "x-api-key" | "custom-header" | "none"

export type ProviderCredentialKind = "api-key" | "codex-oauth"

export interface Provider {
  id: string
  name: string
  prefix: string
  baseUrl: string
  protocol: Protocol
  authType: AuthType
  authHeader?: string
  headers: Record<string, string>
  enabled: boolean
  createdAt: string
  apiKeyCount: number
  enabledApiKeyCount: number
  modelCount: number
  enabledModelCount: number
}

export type ProviderSummary = Provider

export interface ProviderApiKey {
  id: string
  providerId: string
  name: string
  key: string
  credentialKind?: ProviderCredentialKind
  refreshToken?: string
  idToken?: string
  accountId?: string
  email?: string
  planType?: string
  expiresAt?: string
  lastRefresh?: string
  enabled: boolean
  rpmLimit?: number
  maxConcurrency?: number
  /** Internal routing weight derived from the key's position in the provider list. */
  priority?: number
  createdAt: string
}

export interface Model {
  id: string
  providerId: string
  // The user-facing model name used by gateway requests; `id` is Firestore's document ID.
  gatewayModelId: string
  name: string
  upstreamModel: string
  protocol?: Protocol
  upstreamPath?: string
  requestOverrides?: Record<string, unknown>
  enabled: boolean
  createdAt: string
}

export interface ModelAlias {
  id: string
  // The user-facing gateway model ID; globally unique across all aliases.
  alias: string
  name: string
  // gatewayModelId of the model this alias forwards to.
  targetModelId: string
  createdAt: string
}

export interface ApiKey {
  id: string
  name: string
  key: string
  createdAt: string
}

export type PricingConfidence = "exact" | "unpriced" | "assumed"

export interface UsageEvent {
  id: string
  gatewayKeyId: string
  providerId?: string
  providerModelId?: string
  gatewayModelId: string
  protocol: Protocol
  startedAt: string
  completedAt: string
  status: number
  durationMs: number
  ttftMs?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costMicros: number
  pricingConfidence: PricingConfidence
  usageAvailable: boolean
  pricingGroupId?: string
  pricingVersionId?: string
  pricingContextTier?: string
}

export interface UsageRollup {
  id: string
  granularity: "hourly" | "daily" | "monthly"
  bucketStart: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costMicros: number
  updatedAt: string
}

export interface ModelPricing {
  id: string
  modelId: string
  provider: string
  gatewayModelId: string
  upstreamModel: string
  inputMicrosPerMillion: number
  outputMicrosPerMillion: number
  cacheReadMicrosPerMillion: number
  cacheCreationMicrosPerMillion: number
  enabled: boolean
  updatedAt: string
}

export interface PricingRates {
  inputMicrosPerMillion: number
  outputMicrosPerMillion: number
  cacheReadMicrosPerMillion: number
  cacheCreationMicrosPerMillion: number
}

export interface PricingContextTier extends PricingRates {
  id: string
  thresholdTokens: number
}

export type PricingCanonicalSource = "models.dev" | "custom"

export interface CanonicalModelSummary {
  id: string
  name: string
  provider: string
  family: string | null
  pricing: PricingRates
  contextLimit: number | null
  source: PricingCanonicalSource
}

export type PricingGroupKind = "fixed" | "custom"

export interface ModelPricingGroup {
  id: string
  name: string
  kind: PricingGroupKind
  groupKey?: string
  memberModelIds: string[]
  excludedModelIds: string[]
  addedModelIds?: string[]
  canonicalModelId?: string
  canonicalSource?: PricingCanonicalSource
  canonicalModelName?: string
  canonicalProvider?: string
  createdAt: string
  updatedAt: string
}

export interface ModelPricingVersion extends PricingRates {
  id: string
  groupId: string
  version: number
  effectiveAt: string
  createdAt: string
  updatedAt: string
  contextTiers: PricingContextTier[]
}

export type PricingJobStatus = "queued" | "running" | "completed" | "failed"

export interface PricingJob {
  id: string
  groupId: string
  versionId: string
  status: PricingJobStatus
  totalEvents: number
  processedEvents: number
  startedAt?: string
  completedAt?: string
  error?: string
  updatedAt: string
}

export interface GatewayKeyBudget {
  apiKeyId: string
  weeklyLimitMicros: number
  enabled: boolean
  spentMicros: number
  windowStart: string
  windowEnd: string
  updatedAt: string
}

export type BudgetWindowAnchor = "codex" | "custom"

export interface BudgetWindow {
  start: string
  end: string
  anchor: BudgetWindowAnchor
  codexAccountId?: string | null
  bypassLimits: boolean
  bypassSessionId?: string | null
  updatedAt: string
}

export interface BudgetBypassSession {
  id: string
  startedAt: string
  endedAt: string | null
}

export interface DashboardQuery {
  preset: "today" | "yesterday" | "week" | "lastWeek" | "month" | "lastMonth" | "year" | "all" | "custom" | "budget"
  from?: string
  to?: string
  granularity?: "auto" | "hourly" | "daily" | "weekly" | "monthly"
}

export interface DashboardKeyBudget {
  weeklyLimitMicros: number
  spentMicros: number
  remainingMicros: number
  percentUsed: number
  bypassLimits: boolean
  usageStartAt: string
  windowStart: string
  windowEnd: string
}

export interface DashboardPayload {
  generatedAt: string
  range: { label: string; from: string; to: string; granularity: string }
  summary: { requests: number; tokens: number; costMicros: number; activeKeys: number; pricedRequests: number; unpricedRequests: number }
  trend: Array<{ bucketStart: string; label: string; requests: number; tokens: number; costMicros: number }>
  keys: Array<{ id: string; label: string; maskedKey: string; requests: number; tokens: number; costMicros: number; models: string[]; lastUsed: string | null; budget?: DashboardKeyBudget }>
  models: Array<{ model: string; requests: number; tokens: number; costMicros: number }>
  freshness: { source: "firestore" | "memory"; lastEventAt: string | null }
  pricingConfidence: { pricedRequests: number; unpricedRequests: number }
}

export interface PublicDashboardPayload extends DashboardPayload {
  keys: Array<Omit<DashboardPayload["keys"][number], "id"> & { id: string }>
}

export interface CodexLimitPayload {
  accountId: string
  name: string
  planType?: string
  enabled: boolean
  fiveHour: { usedPercent: number; remainingPercent: number; resetAt?: string } | null
  weekly: { usedPercent: number; remainingPercent: number; resetAt?: string } | null
  unusedResetCredits: number
  additionalPools: Array<{ label: string; fiveHour: CodexLimitPayload["fiveHour"]; weekly: CodexLimitPayload["weekly"] }>
  error?: string
}

export interface CodexResetResult {
  ok: boolean
  redeemRequestId: string
  status: number
  message: string
}

export interface AppData {
  version: 4
  admin: {
    username: string
    passwordHash: string
    mustChangePassword: boolean
  }
  sessionSecret: string
  providers: Provider[]
  providerApiKeys: ProviderApiKey[]
  models: Model[]
  aliases: ModelAlias[]
  apiKeys: ApiKey[]
}

export const protocolPaths: Record<Protocol, string> = {
  "openai-chat": "/v1/chat/completions",
  "openai-responses": "/v1/responses",
  "anthropic-messages": "/v1/messages",
}

export const protocolLabels: Record<Protocol, string> = {
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
}
