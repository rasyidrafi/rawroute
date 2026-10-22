import type { PricingServiceTier, Protocol } from "./domain"

export type ServiceTierProfile = "openai" | "anthropic"

/** Keep provider tier identifiers, not UI mode names, as the accounting key. */
export function normalizeServiceTier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const tier = value.trim().toLowerCase()
  return /^[a-z][a-z0-9_-]{0,63}$/.test(tier) ? tier : undefined
}

export function serviceTierLabel(tier: string) {
  return ({ default: "Standard", standard: "Standard", priority: "Fast (OpenAI)", fast: "Fast (Anthropic)", ultrafast: "Ultrafast", flex: "Flex", auto: "Auto" } as Record<string, string>)[tier] || tier
}

export function serviceTierProfile(protocol: Protocol): ServiceTierProfile {
  return protocol === "anthropic-messages" ? "anthropic" : "openai"
}

export function requestServiceTier(payload: Record<string, unknown>, profile: ServiceTierProfile) {
  const tier = normalizeServiceTier(profile === "anthropic" ? payload.speed : payload.service_tier)
  if (profile === "openai" && tier === "fast") return "priority"
  return tier === "standard" ? "default" : tier
}

/** Catalog refresh cannot silently overwrite user-owned rates or multipliers. */
export function mergeCatalogServiceTiers(current: PricingServiceTier[] = [], catalog: PricingServiceTier[] = []) {
  const merged = new Map(current.map(tier => [tier.serviceTier, tier]))
  for (const tier of catalog) if (merged.get(tier.serviceTier)?.source !== "custom") merged.set(tier.serviceTier, { ...tier, source: "catalog" })
  return [...merged.values()].sort((a, b) => a.serviceTier.localeCompare(b.serviceTier))
}
