import { Badge } from "@rawroute/ui/badge"
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
  return { confirmed, detail: `${detail}; source: ${source}`, label: selected ? serviceTierLabel(selected) : "Tier unknown" }
}

export function ServiceTierBadge({ event }: { event: TierEvent }) {
  const display = tierDisplay(event)
  return <Badge variant={display.confirmed ? "secondary" : "outline"} title={display.detail}>{display.label}</Badge>
}
