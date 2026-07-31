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

export interface ApiKey {
  id: string
  name: string
  key: string
  createdAt: string
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
