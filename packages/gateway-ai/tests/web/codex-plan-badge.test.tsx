import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CodexPlanBadge } from "../../src/web/components/codex-quota"

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
