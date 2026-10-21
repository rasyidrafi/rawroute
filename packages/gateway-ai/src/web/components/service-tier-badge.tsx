import { Badge } from "@rawroute/ui/badge"
import { normalizeServiceTier, serviceTierLabel } from "../../contracts/service-tier"
import type { UsageEvent } from "../../contracts/domain"

export function ServiceTierBadge({ event }: { event: Pick<UsageEvent, "requestedServiceTier" | "effectiveServiceTier" | "pricingServiceTier" | "pricingConfidence"> }) {
  const requested = normalizeServiceTier(event.requestedServiceTier)
  const reported = normalizeServiceTier(event.effectiveServiceTier)
  const effective = reported === "auto" ? undefined : reported
  if (!requested && !effective && (!event.pricingServiceTier || event.pricingConfidence !== "assumed")) return null
  if (!effective) return <Badge variant="outline" title="The provider did not report the served tier. The requested mode is not confirmed.">{requested && requested !== "auto" ? `${serviceTierLabel(requested)} requested · unconfirmed` : "Tier unreported"}</Badge>
  const changed = requested && requested !== "auto" && serviceTierLabel(requested) !== serviceTierLabel(effective)
  return <Badge variant="secondary" title={`Served tier: ${effective}${requested ? `; requested: ${requested}` : ""}`}>{changed ? `${serviceTierLabel(requested)} → ${serviceTierLabel(effective)}` : serviceTierLabel(effective)}</Badge>
}
