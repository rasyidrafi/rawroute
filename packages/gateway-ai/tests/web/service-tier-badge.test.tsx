import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ServiceTierBadge } from "../../src/web/components/service-tier-badge"

test("tier badge follows upstream, sent payload, then user payload without provenance in its label", () => {
  const cases = [
    { requestedServiceTier: "priority", sentServiceTier: "flex", effectiveServiceTier: "default", label: "Standard", source: "upstream response" },
    { requestedServiceTier: "priority", sentServiceTier: "flex", label: "Flex", source: "gateway payload" },
    { requestedServiceTier: "priority", sentServiceTier: "auto", label: "Auto", source: "gateway payload" },
    { requestedServiceTier: "priority", effectiveServiceTier: "auto", label: "Fast (OpenAI)", source: "user payload" },
    { requestedServiceTier: "auto", label: "Auto", source: "user payload" },
    { label: "Tier unknown", source: "not recorded" },
  ]
  for (const { label, source, ...tiers } of cases) {
    const markup = renderToStaticMarkup(<ServiceTierBadge event={{ ...tiers, pricingConfidence: "unpriced" }} />)
    expect(markup).toContain(`>${label}</span>`)
    expect(markup).toContain(`source: ${source}`)
    expect(markup).toContain("Requested:")
    expect(markup).toContain("sent by gateway:")
    expect(markup).toContain("served:")
    expect(markup).not.toContain(" · confirmed")
    expect(markup).not.toContain(" · assumed")
    expect(markup).not.toContain(" · unpriced")
  }
})
