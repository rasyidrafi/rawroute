import { normalizeServiceTier, selectServiceTier, serviceTierLabel } from "../../contracts/service-tier"
import type { UsageEvent } from "../../contracts/domain"

type TierEvent = Pick<UsageEvent, "requestedServiceTier" | "sentServiceTier" | "effectiveServiceTier" | "pricingServiceTier" | "pricingConfidence">

function tierDisplay(event: TierEvent) {
  const requested = normalizeServiceTier(event.requestedServiceTier)
  const sent = normalizeServiceTier(event.sentServiceTier)
  const reported = normalizeServiceTier(event.effectiveServiceTier)
  const effective = reported === "auto" ? undefined : reported
  const { tier: selected, source } = selectServiceTier(event)
  const confirmed = source === "upstream response"
  const evidence = confirmed ? "confirmed" : selected && selected !== "auto" ? "assumed" : "unknown"
  const detail = `Requested: ${requested || "not specified"}; sent by gateway: ${sent || "not recorded"}; served: ${effective || "unreported"}; evidence: ${evidence}; pricing: ${event.pricingConfidence}`
  return { detail: `${detail}; source: ${source}`, label: selected ? serviceTierLabel(selected) : "Unknown" }
}

export function ServiceTierField({ event }: { event: TierEvent }) {
  const display = tierDisplay(event)
  return <div className="min-w-0 whitespace-normal text-xs text-muted-foreground" title={display.detail}>Tier: <span className="font-mono break-all">{display.label}</span></div>
}
