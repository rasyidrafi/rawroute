import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RequestLogResults } from "./request-logs-view"
import type { RequestLogDisplayEvent } from "@/lib/request-logs"

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
