import type { PricingContextTier, PricingRates, PricingServiceTier } from "../contracts/domain"
import { selectServiceTier, type ServiceTierContext } from "../contracts/service-tier"

export type TieredPricing = PricingRates & { contextTiers?: PricingContextTier[]; serviceTiers?: PricingServiceTier[] }

/** Apply the shared tier policy. Unknown schedules never silently fall back to Standard. */
export function selectServiceTierPricing(pricing: TieredPricing | undefined, context: ServiceTierContext = {}) {
  const selection = selectServiceTier(context)
  const selected = selection.tier && selection.tier !== "auto" ? selection.tier : "default"
  const standard = selected === "default" || selected === "standard"
  const rates = standard ? pricing : pricing?.serviceTiers?.find(tier => tier.serviceTier === selected)
  return {
    rates,
    serviceTier: selected,
    assumed: selection.source !== "upstream response" && (selection.tier !== undefined || Boolean(pricing?.serviceTiers?.length)),
  }
}
