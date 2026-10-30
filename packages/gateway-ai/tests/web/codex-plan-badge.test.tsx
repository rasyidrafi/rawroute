import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CodexPlanBadge, CodexQuotaTableCell } from "../../src/web/components/codex-quota"

test("hides the old exhausted percentage while a redeemed quota refreshes", () => {
  const markup = renderToStaticMarkup(<CodexQuotaTableCell loading={false} accountUsage={{ fiveHour: null, weekly: { usedPercent: 100, remainingPercent: 0 }, fetchedAt: null, stale: false, refreshPending: true }} />)
  expect(markup).toContain("Refreshing quota…")
  expect(markup).not.toContain("0%")
})

test("renders the reported Free plan even when quota windows are unavailable", () => {
  const markup = renderToStaticMarkup(<CodexPlanBadge loading={false} accountUsage={{ planType: "free", fiveHour: null, weekly: null, fetchedAt: "2026-10-21T00:00:00Z", stale: false }} />)
  expect(markup).toContain(">Free</span>")
  expect(markup).not.toContain("Plus")
})

test("distinguishes unknown, loading, and stale plans", () => {
  expect(renderToStaticMarkup(<CodexPlanBadge loading={false} />)).toContain(">Unknown</span>")
  expect(renderToStaticMarkup(<CodexPlanBadge loading />)).toContain("Loading plan")
  expect(renderToStaticMarkup(<CodexPlanBadge loading={false} accountUsage={{ planType: "plus", fiveHour: null, weekly: null, fetchedAt: "2026-10-21T00:00:00Z", stale: true }} />)).toContain("Plus · stale")
})
