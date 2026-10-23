import type { PricingServiceTier, Protocol } from "./domain"

export type ServiceTierProfile = "openai" | "anthropic"
export type ServiceTierContext = { requestedServiceTier?: string; sentServiceTier?: string; effectiveServiceTier?: string }

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

/** A Standard response does not cancel an explicit non-Standard client tier. */
export function selectServiceTier(context: ServiceTierContext) {
  const requested = normalizeServiceTier(context.requestedServiceTier)
  const sent = normalizeServiceTier(context.sentServiceTier)
  const reported = normalizeServiceTier(context.effectiveServiceTier)
  const effective = reported === "auto" ? undefined : reported
  if ((effective === "default" || effective === "standard") && requested && !["default", "standard", "auto"].includes(requested)) {
    return { tier: requested, source: "user payload" as const }
  }
  if (effective) return { tier: effective, source: "upstream response" as const }
  if (sent) return { tier: sent, source: "gateway payload" as const }
  return { tier: requested, source: requested ? "user payload" as const : "not recorded" as const }
}

/** Catalog refresh cannot silently overwrite user-owned rates or multipliers. */
export function mergeCatalogServiceTiers(current: PricingServiceTier[] = [], catalog: PricingServiceTier[] = []) {
  const merged = new Map(current.map(tier => [tier.serviceTier, tier]))
  for (const tier of catalog) if (merged.get(tier.serviceTier)?.source !== "custom") merged.set(tier.serviceTier, { ...tier, source: "catalog" })
  return [...merged.values()].sort((a, b) => a.serviceTier.localeCompare(b.serviceTier))
}
