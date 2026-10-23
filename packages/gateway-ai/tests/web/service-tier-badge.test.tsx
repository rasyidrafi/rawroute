import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ServiceTierBadge } from "../../src/web/components/service-tier-badge"

test("tier badge preserves requested non-Standard tiers when upstream reports Standard", () => {
  const cases = [
    { requestedServiceTier: "priority", sentServiceTier: "flex", effectiveServiceTier: "default", label: "Fast (OpenAI)", source: "user payload" },
    { requestedServiceTier: "ultrafast", effectiveServiceTier: "standard", label: "Ultrafast", source: "user payload" },
    { requestedServiceTier: "fast", effectiveServiceTier: "default", label: "Fast (Anthropic)", source: "user payload" },
    { requestedServiceTier: "custom-tier", effectiveServiceTier: "default", label: "custom-tier", source: "user payload" },
    { requestedServiceTier: "default", effectiveServiceTier: "priority", label: "Fast (OpenAI)", source: "upstream response" },
    { requestedServiceTier: "ultrafast", effectiveServiceTier: "priority", label: "Fast (OpenAI)", source: "upstream response" },
    { requestedServiceTier: "standard", effectiveServiceTier: "default", label: "Standard", source: "upstream response" },
    { requestedServiceTier: "auto", effectiveServiceTier: "default", label: "Standard", source: "upstream response" },
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

test("requested-tier fallback keeps the upstream report and assumed evidence in the tooltip", () => {
  const markup = renderToStaticMarkup(<ServiceTierBadge event={{ requestedServiceTier: "priority", sentServiceTier: "priority", effectiveServiceTier: "default", pricingConfidence: "assumed" }} />)
  expect(markup).toContain(">Fast (OpenAI)</span>")
  expect(markup).toContain("served: default; evidence: assumed; pricing: assumed")
  expect(markup).toContain("source: user payload")
})
