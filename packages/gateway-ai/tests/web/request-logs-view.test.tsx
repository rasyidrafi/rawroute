import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RequestLogResults } from "../../src/web/components/request-logs-view"
import type { RequestLogDisplayEvent } from "../../src/contracts/request-logs"
import { RequestAttemptRow, requestGroupSummary } from "../../src/web/components/request-log-rows"

const event = (id: string, metadata: Pick<RequestLogDisplayEvent, "reasoningEffort" | "toolCount"> = {}): RequestLogDisplayEvent => ({
  id,
  gatewayModelId: "provider/model",
  routing: { modelId: "provider/model", modelName: "Model" },
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

test("groups fallback attempts and directly displays the only recorded usage", () => {
  const main = { ...event("failed"), requestId: "request-chain", requestedModel: "astra-auto", attemptIndex: 0, requestFinal: false, status: 400, usageAvailable: false, pricingConfidence: "unpriced" as const }
  const fallback = { ...event("success"), requestId: "request-chain", requestedModel: "astra-auto", attemptIndex: 1, requestFinal: true }
  const markup = renderToStaticMarkup(<RequestLogResults data={{ events: [fallback, main] }} loading={false} failed={false} />)
  expect(markup).toContain('aria-expanded="false"')
  expect(markup).toContain("Expand request request-chain")
  expect(markup).toContain("astra-auto")
  expect(markup).toContain("Success")
  expect(markup).not.toContain("via fallback")
  expect(markup).not.toContain("Known usage · partial")
  expect(markup).toContain("2 in · 0 cache · 1 out")
  expect(markup).toContain("Partial cost")
  expect(markup).not.toContain('data-slot="request-attempt-row"')
  expect(requestGroupSummary([main, fallback])).toMatchObject({ tokens: 3, cost: 0, partialCost: true, partialUsage: true, singleUsage: fallback })
  const child = renderToStaticMarkup(<table><tbody><RequestAttemptRow event={main} nested /></tbody></table>)
  expect(child).toContain("Main")
  expect(child).toContain("Failed")
  expect(child).toContain("provider/model")
  expect(child).not.toContain("Outcome pending")
})

test("multiple recorded usages retain complete or partial aggregate totals", () => {
  const main = { ...event("main"), requestId: "chain", attemptIndex: 0, requestFinal: false, status: 503 }
  const fallback = { ...event("fallback"), requestId: "chain", attemptIndex: 1, requestFinal: true }
  const missing = { ...main, id: "missing", attemptIndex: 2, usageAvailable: false }
  const complete = renderToStaticMarkup(<RequestLogResults data={{ events: [main, fallback] }} loading={false} failed={false} />)
  expect(complete).toContain("All attempts")
  expect(complete).not.toContain("Known usage · partial")
  expect(requestGroupSummary([main, fallback])).toMatchObject({ tokens: 6, partialUsage: false, singleUsage: undefined })
  const partial = renderToStaticMarkup(<RequestLogResults data={{ events: [main, fallback, missing] }} loading={false} failed={false} />)
  expect(partial).toContain("Known usage · partial")
  expect(requestGroupSummary([main, fallback, missing])).toMatchObject({ tokens: 6, partialUsage: true, singleUsage: undefined })
  const unavailable = renderToStaticMarkup(<RequestLogResults data={{ events: [missing] }} loading={false} failed={false} />)
  expect(unavailable).toContain("Provider usage not recorded")
  expect(unavailable).not.toContain("Known usage · partial")
})

test("historical attempts stay separate and incomplete chains do not claim final failure", () => {
  const markup = renderToStaticMarkup(<RequestLogResults data={{ events: [event("one"), event("two")] }} loading={false} failed={false} />)
  expect(markup.match(/Historical attempt/g)).toHaveLength(2)
  expect(markup).not.toContain("Expand request")
  const pending = renderToStaticMarkup(<RequestLogResults data={{ events: [{ ...event("pending"), requestId: "inflight", attemptIndex: 0, requestFinal: false, status: 400 }] }} loading={false} failed={false} />)
  expect(pending).toContain("Outcome pending / unavailable")
  expect(pending).not.toContain(">Failed")
})

test("shared owner renders one execution with consumer identity, not an inherited fallback group", () => {
  const owner = { ...event("owner"), requestId: "consumer-chain", requestedModel: "luna", attemptIndex: 1, requestFinal: false,
    keyName: null, gatewayKeyId: "shared-workspace:consumer",
    sharedUsage: { shareId: "share", role: "owner" as const, peerWorkspaceId: "consumer", peerWorkspaceName: "HT Non SHI", sourceGatewayModelId: "codex/luna" },
    routing: { modelId: "codex/luna", modelName: "GPT-6 Luna", routeName: "Clever" },
  }
  const markup = renderToStaticMarkup(<RequestLogResults data={{ events: [owner] }} loading={false} failed={false} />)
  expect(markup).toContain("GPT-6 Luna")
  expect(markup).toContain("(as Clever)")
  expect(markup).toContain("Shared usage · HT Non SHI")
  expect(markup).toContain("Payload:")
  expect(markup).toContain("Resolved:")
  expect(markup).toContain("codex/luna")
  expect(markup).toContain("Success")
  expect(markup).not.toContain("Fallback")
  expect(markup).not.toContain("via fallback")
  expect(markup).not.toContain("Unknown key")
  expect(markup).not.toContain("Outcome pending")
  expect(markup).not.toContain("Expand request")
  expect(markup.match(/data-slot="request-log-row"/g)).toHaveLength(1)
})

test("recorded names win over renamed catalog labels and historical routing is not invented", () => {
  const recorded = { ...event("snapshot"), requestedModel: "A", modelName: "Renamed pricing group", routing: { modelId: "provider/astra", modelName: "GPT-6 Astra", routeName: "Clever" } }
  const markup = renderToStaticMarkup(<table><tbody><RequestAttemptRow event={recorded} /></tbody></table>)
  expect(markup).toContain("GPT-6 Astra")
  expect(markup).toContain("(as Clever)")
  expect(markup).not.toContain("Renamed pricing group")
  expect(markup).toContain("Copy payload model A")
  expect(markup).toContain("Copy resolved model provider/astra")
  const historical = renderToStaticMarkup(<table><tbody><RequestAttemptRow event={{ ...event("historical"), routing: undefined }} /></tbody></table>)
  expect(historical).toContain("Not recorded")
  expect(historical).not.toContain("Copy resolved")
  expect(historical).not.toContain("(as ")
})

test("request model titles omit only aliases identical to the displayed model name", () => {
  const render = (changes: Partial<RequestLogDisplayEvent>) => renderToStaticMarkup(<table><tbody><RequestAttemptRow event={{ ...event("title"), ...changes }} /></tbody></table>)

  const identical = render({ routing: { modelId: "provider/model", modelName: "Model", routeName: "Model" } })
  expect(identical).toContain(">Model</span>")
  expect(identical).not.toContain("(as Model)")

  const distinct = render({ routing: { modelId: "provider/model", modelName: "Model", routeName: "Clever" } })
  expect(distinct).toContain("(as Clever)")

  const caseDifferent = render({ routing: { modelId: "provider/model", modelName: "Model", routeName: "model" } })
  expect(caseDifferent).toContain("(as model)")

  const whitespaceDifferent = render({ routing: { modelId: "provider/model", modelName: "Model", routeName: " Model" } })
  expect(whitespaceDifferent).toContain("(as  Model)")

  const recordedNameFallback = render({ modelName: "Recorded", routing: { modelId: "provider/model", modelName: "", routeName: "Recorded" } })
  expect(recordedNameFallback).toContain(">Recorded</span>")
  expect(recordedNameFallback).not.toContain("(as Recorded)")

  const gatewayIdFallback = render({ modelName: null, routing: { modelId: "provider/model", modelName: "", routeName: "provider/model" } })
  expect(gatewayIdFallback).toContain(">provider/model</span>")
  expect(gatewayIdFallback).not.toContain("(as provider/model)")
})
