export type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages"

export type AuthType = "bearer" | "x-api-key" | "custom-header" | "none"

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
}

export interface ProviderApiKey {
  id: string
  providerId: string
  name: string
  key: string
  enabled: boolean
  rpmLimit?: number
  maxConcurrency?: number
  priority?: number
  createdAt: string
}

export interface Model {
  id: string
  providerId: string
  name: string
  upstreamModel: string
  protocol?: Protocol
  upstreamPath?: string
  unprefixed?: boolean
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
  version: 2
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
