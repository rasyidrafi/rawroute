import type { ProviderApiKey } from "@/lib/types"

export function countProviderApiKeys(providerId: string, apiKeys: ProviderApiKey[]) {
  const configured = apiKeys.filter((apiKey) => apiKey.providerId === providerId)
  return {
    configured: configured.length,
    enabled: configured.filter((apiKey) => apiKey.enabled).length,
  }
}
