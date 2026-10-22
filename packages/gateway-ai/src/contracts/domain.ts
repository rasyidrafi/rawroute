import type { Workspace } from "@rawroute/platform/contracts/workspace"

export type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages"

export type AuthType = "bearer" | "x-api-key" | "none"

export type ProviderCredentialKind = "api-key" | "codex-cli-proxy"

export interface Provider {
  id: string
  name: string
  prefix: string
  baseUrl: string
  protocol: Protocol
  authType: AuthType
  headers: Record<string, string>
  /** Opt in to CLIProxy's prompt_cache_key projection for OpenAI-compatible providers. */
  supportPromptCacheKey?: boolean
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
  accountId?: string
  email?: string
  planType?: string
  expiresAt?: string
  lastRefresh?: string
  /** CLIProxy-owned Codex credential mapping. RawRoute never stores its tokens. */
  cliProxyAuthFile?: string
  cliProxyAuthIndex?: string
  cliProxyStatus?: string
  cliProxyStatusMessage?: string
  enabled: boolean
  rpmLimit?: number
  maxConcurrency?: number
  /** Internal routing weight derived from the key's position in the provider list. */
  priority?: number
  createdAt: string
}

export type ModelSource = "custom" | "discovered"

export interface Model {
  id: string
  providerId: string
  // The user-facing model name used by gateway requests; `id` is the document ID.
  gatewayModelId: string
  name: string
  upstreamModel: string
  enabled: boolean
  /** User-owned mapping or automatically discovered route. */
  source?: ModelSource
  discovery?: { lastSeenAt?: string; accountIds: string[]; stale: boolean }
  reasoningCapability?: ModelReasoningCapability
  serviceTierCapability?: ModelServiceTierCapability
  createdAt: string
}

export interface ModelServiceTierCapability {
  profile: "openai" | "anthropic"
  /** Explicitly supported non-standard tiers; empty means Standard only. */
  supportedTiers: string[]
}

export interface ModelReasoningCapability {
  mode: "auto" | "enabled" | "disabled"
  supportedEfforts?: string[]
}

export interface ModelAlias {
  id: string
  // The user-facing gateway model ID; globally unique across all aliases.
  alias: string
  name: string
  // gatewayModelId of the model this alias forwards to.
  targetModelId: string
  /** A cross-workspace model grant. Local aliases leave this unset. */
  sharedModelId?: string
  createdAt: string
}

export type ComboReasoningMode = "inherit" | "provider-default" | "override"

export interface ComboMemberValidation {
  status: "verified" | "unverified" | "invalid" | "stale"
  testedAt?: string
  message?: string
  configHash?: string
}

export interface ComboMember {
  modelId: string
  sharedModelId?: string
  reasoning?: { mode: ComboReasoningMode; effort?: string }
  customPayload?: Record<string, unknown>
  validation?: ComboMemberValidation
}

/** A named, ordered fallback chain of resolvable gateway model IDs. */
export interface ModelCombo {
  id: string
  combo: string
  name: string
  members: ComboMember[]
  createdAt: string
}

export interface ModelShare {
  id: string
  ownerWorkspaceId: string
  recipientWorkspaceId: string
  sourceProviderId: string
  sourceModelId: string
  sourceGatewayModelId: string
  status: "active" | "revoked"
  createdAt: string
  updatedAt: string
}

export interface SharedModelView {
  id: string
  ownerWorkspaceId: string
  ownerWorkspaceName: string
  sourceProviderId: string
  sourceModelId: string
  sourceGatewayModelId: string
  sourceModelName: string
  providerName: string
  qualifiedModelId: string
  status: "active" | "revoked" | "unavailable"
}

export interface ApiKey {
  id: string
  name: string
  key: string
  createdAt: string
}

export interface AuthenticatedGatewayKey {
  workspace: Workspace
  apiKey: ApiKey
}

export type PricingConfidence = "exact" | "unpriced" | "assumed"
export type UsageCompleteness = "complete" | "partial" | "missing"
export type ReasoningEffort = "none" | "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

/** Immutable routing identity captured before forwarding; absent on older logs. */
export interface UsageRoutingSnapshot {
  modelId: string
  modelName: string
  /** Display name of the client-selected alias/combo, not an internal member alias. */
  routeName?: string
}

export interface UsageEvent {
  id: string
  /** Gateway ingress identity; absent on historical attempts without correlation. */
  requestId?: string
  /** Original client payload model, before combo/alias resolution. */
  requestedModel?: string
  routing?: UsageRoutingSnapshot
  /** Zero-based router attempt order in the consumer workspace; retained on owner copies for correlation. */
  attemptIndex?: number
  /** This attempt determines the final request outcome. */
  requestFinal?: boolean
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
  /** Serialized request body size used to calibrate missing-usage estimates. */
  requestBodyBytes?: number
  /** Client or router-selected reasoning effort recorded when the request starts. */
  reasoningEffort?: ReasoningEffort
  /** Number of declared tools/functions, absent when the request did not specify them. */
  toolCount?: number
  requestedServiceTier?: string
  sentServiceTier?: string
  effectiveServiceTier?: string
  /** Rate schedule actually used; may be assumed when the provider omitted its tier. */
  pricingServiceTier?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costMicros: number
  pricingConfidence: PricingConfidence
  usageAvailable: boolean
  /** Whether both billable token sides were returned by the provider. */
  usageCompleteness?: UsageCompleteness
  cacheUsageKnown?: boolean
  /** Provenance for migrated or estimated costs; absent on old records. */
  costSource?: "configured-pricing" | "provider-recorded" | "reservation" | "empirical" | "payload-calibrated"
  predictionMethod?: "same-key-model-day-median" | "same-key-model-median" | "same-model-day-median" | "same-model-median" | "same-key-model-p25" | "pooled-model-p25" | "default-model-shrunk-p25" | "openai-codex-payload-calibrated-p50" | "openai-codex-payload-calibrated-p75-reservation"
  predictionSampleCount?: number
  pricingGroupId?: string
  pricingVersionId?: string
  pricingContextTier?: string
  sharedUsage?: {
    shareId: string
    role: "owner" | "consumer"
    peerWorkspaceId: string
    peerWorkspaceName: string
    sourceGatewayModelId: string
  }
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

export interface PricingServiceTier extends PricingRates {
  serviceTier: string
  contextTiers: PricingContextTier[]
  source?: "catalog" | "custom"
  /** Recomputed from Standard rates when a new version is saved. */
  multiplier?: number
}

export type PricingCanonicalSource = "models.dev" | "custom"

export interface CanonicalModelSummary {
  id: string
  name: string
  provider: string
  family: string | null
  pricing: PricingRates
  contextTiers: PricingContextTier[]
  serviceTiers?: PricingServiceTier[]
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
  serviceTiers?: PricingServiceTier[]
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
  bypassAutoDeactivateAtWindowEnd?: boolean
  updatedAt: string
}

export interface BudgetBypassSession {
  id: string
  startedAt: string
  endedAt: string | null
  endReason?: "manual" | "window_end" | null
}

export interface BudgetBeyondLimitsSettings {
  enabled: boolean
  modelIds: string[]
  updatedAt: string
}

export interface BudgetUnlimitedSettings {
  excludedModelIds: string[]
  updatedAt: string
}

export interface DashboardQuery {
  preset: "today" | "yesterday" | "week" | "lastWeek" | "month" | "lastMonth" | "year" | "all" | "custom" | "budget"
  from?: string
  to?: string
  granularity?: "auto" | "hourly" | "daily" | "weekly" | "monthly"
}

export interface DashboardKeyBudget {
  enabled?: boolean
  usageAvailable?: boolean
  weeklyLimitMicros: number
  spentMicros: number | null
  remainingMicros: number | null
  percentUsed: number | null
  bypassLimits: boolean
  usageStartAt: string
  windowStart: string
  windowEnd: string
}

export interface AnalyticsCoverage {
  partial: boolean
  excludedSources: number
  tokenCoveredRequests: number
  statusCoveredRequests: number
  costCoveredRequests: number
  modelCoveredRequests: number
  keyCoveredRequests: number
  durationCount: number
  financialUnavailable: boolean
  unsupportedTrendSources: number
}

export interface DashboardPayload {
  coverage?: AnalyticsCoverage
  generatedAt: string
  range: { label: string; from: string; to: string; granularity: string }
  summary: { requests: number; tokens: number; costMicros: number; activeKeys: number; pricedRequests: number; unpricedRequests: number }
  trend: Array<{ bucketStart: string; label: string; requests: number; tokens: number; costMicros: number }>
  keys: Array<{ id: string; label: string; maskedKey: string; requests: number; tokens: number; costMicros: number; models: string[]; lastUsed: string | null; budget?: DashboardKeyBudget; publicId?: string }>
  models: Array<{ model: string; requests: number; tokens: number; costMicros: number }>
  freshness: { source: "sqlite" | "memory"; lastEventAt: string | null }
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
  providers: Provider[]
  providerApiKeys: ProviderApiKey[]
  models: Model[]
  aliases: ModelAlias[]
  combos: ModelCombo[]
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
