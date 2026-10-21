import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RequestLogResults } from "../../src/web/components/request-logs-view"
import type { RequestLogDisplayEvent } from "../../src/contracts/request-logs"
import { RequestAttemptRow, requestGroupSummary } from "../../src/web/components/request-log-rows"

const event = (id: string, metadata: Pick<RequestLogDisplayEvent, "reasoningEffort" | "toolCount"> = {}): RequestLogDisplayEvent => ({
  id,
  gatewayModelId: "provider/model",
  modelName: "Model",
  keyName: "Key",
  status: 200,
  usageAvailable: true,
  usageCompleteness: "complete",
  totalTokens: 3,
  inputTokens: 2,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 1,
  pricingConfidence: "exact",
  costMicros: 0,
  durationMs: 10,
  completedAt: "2026-10-15T12:00:00.000Z",
  ...metadata,
})

test("request log results place reasoning and tools next to the model and preserve unavailable values", () => {
  const markup = renderToStaticMarkup(<RequestLogResults data={{ events: [
    event("with-tools", { reasoningEffort: "high", toolCount: 2 }),
    event("no-tools", { toolCount: 0 }),
    event("effort-without-tools", { reasoningEffort: "medium" }),
    event("unavailable"),
  ] }} loading={false} failed={false} />)

  expect(markup).toContain("Request / model")
  expect(markup.indexOf("Reasoning / tools")).toBeGreaterThan(markup.indexOf("Request / model"))
  expect(markup.indexOf("Reasoning / tools")).toBeLessThan(markup.indexOf(">Key</th>"))
  expect(markup).toContain('title="Requested or router-selected effort and declared tool definitions; unknown means no effort was recorded, and undeclared tools means no tool metadata was recorded. Not actual reasoning or executed tool calls."')
  expect(markup).toContain(">high</div><div class=\"text-xs text-muted-foreground\">2 declared tools</div>")
  expect(markup).toContain(">unknown</div><div class=\"text-xs text-muted-foreground\">0 declared tools</div>")
  expect(markup).toContain(">medium</div><div class=\"text-xs text-muted-foreground\">undeclared tools</div>")
  expect(markup).toContain(">unknown</div><div class=\"text-xs text-muted-foreground\">undeclared tools</div>")
  expect(markup).toContain('data-slot="table-container"')
})

test("groups explicit fallback attempts into a collapsed parent with honest partial totals", () => {
  const main = { ...event("failed"), requestId: "request-chain", requestedModel: "astra-auto", attemptIndex: 0, requestFinal: false, status: 400, usageAvailable: false, pricingConfidence: "unpriced" as const }
  const fallback = { ...event("success"), requestId: "request-chain", requestedModel: "astra-auto", attemptIndex: 1, requestFinal: true }
  const markup = renderToStaticMarkup(<RequestLogResults data={{ events: [fallback, main] }} loading={false} failed={false} />)
  expect(markup).toContain('aria-expanded="false"')
  expect(markup).toContain("Expand request request-chain")
  expect(markup).toContain("astra-auto")
  expect(markup).toContain("Success via fallback")
  expect(markup).toContain("Known usage · partial")
  expect(markup).toContain("Partial cost")
  expect(markup).not.toContain('data-slot="request-attempt-row"')
  expect(requestGroupSummary([main, fallback])).toMatchObject({ tokens: 3, cost: 0, partialCost: true, partialUsage: true })
  const child = renderToStaticMarkup(<table><tbody><RequestAttemptRow event={main} nested /></tbody></table>)
  expect(child).toContain("Main")
  expect(child).toContain("Failed")
  expect(child).toContain("provider/model")
  expect(child).not.toContain("Outcome pending")
})

test("historical attempts stay separate and incomplete chains do not claim final failure", () => {
  const markup = renderToStaticMarkup(<RequestLogResults data={{ events: [event("one"), event("two")] }} loading={false} failed={false} />)
  expect(markup.match(/Historical attempt/g)).toHaveLength(2)
  expect(markup).not.toContain("Expand request")
  const pending = renderToStaticMarkup(<RequestLogResults data={{ events: [{ ...event("pending"), requestId: "inflight", attemptIndex: 0, requestFinal: false, status: 400 }] }} loading={false} failed={false} />)
  expect(pending).toContain("Outcome pending / unavailable")
  expect(pending).not.toContain(">Failed")
})
