import type { PricingContextTier, PricingRates, PricingServiceTier } from "../contracts/domain"
import { normalizeServiceTier } from "../contracts/service-tier"

export type TieredPricing = PricingRates & { contextTiers?: PricingContextTier[]; serviceTiers?: PricingServiceTier[] }
export type ServiceTierContext = { requestedServiceTier?: string; sentServiceTier?: string; effectiveServiceTier?: string }

/** Reported tier wins. Unknown schedules never silently fall back to Standard. */
export function selectServiceTierPricing(pricing: TieredPricing | undefined, context: ServiceTierContext = {}) {
  const requested = normalizeServiceTier(context.sentServiceTier ?? context.requestedServiceTier)
  const reported = normalizeServiceTier(context.effectiveServiceTier)
  const effective = reported === "auto" ? undefined : reported
  const selected = effective || (requested === "auto" ? undefined : requested) || "default"
  const standard = selected === "default" || selected === "standard"
  const rates = standard ? pricing : pricing?.serviceTiers?.find(tier => tier.serviceTier === selected)
  return {
    rates,
    serviceTier: selected,
    assumed: !effective && (requested !== undefined || Boolean(pricing?.serviceTiers?.length)),
  }
}
