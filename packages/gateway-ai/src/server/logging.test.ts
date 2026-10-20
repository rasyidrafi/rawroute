import { expect, test } from "bun:test"
import { safeDetails } from "./logging"

test("dashboard performance metadata admits finite counts but not payloads or credentials", () => {
  expect(safeDetails({ action: "budget.rows", durationMs: 1.25, count: 100, hourlyRows: 20, dailyRows: 3, boundaryRows: 0, rollupRows: Infinity, payload: { keys: ["private"] }, authorization: "Bearer private" })).toEqual({ action: "budget.rows", durationMs: 1.25, count: 100, hourlyRows: 20, dailyRows: 3, boundaryRows: 0 })
})

test("metadata excludes credentials, free-form errors, URLs, control characters and unbounded values", () => {
  expect(safeDetails({ status: 200, durationMs: 10, apiKeyId: "key-id", model: "provider/model", inputTokens: 42, terminalEvent: true,
    password: "private", apiKey: "sk-private", error: "secret failure", prompt: "private", url: "https://host/?token=private",
    accountId: "sk-secret", providerId: "injected\nline", outputTokens: Infinity, source: "x".repeat(200), unknown: 12,
  })).toEqual({ status: 200, durationMs: 10, apiKeyId: "key-id", model: "provider/model", inputTokens: 42, terminalEvent: true })
})

test("log metadata restricts reasoning and tools to reviewed values and nonnegative counts", () => {
  expect(safeDetails({ reasoningEffort: " HIGH ", toolCount: 0 })).toEqual({ reasoningEffort: "high", toolCount: 0 })
  expect(safeDetails({ reasoningEffort: "customer-private-value", toolCount: -1 })).toEqual({})
  expect(safeDetails({ reasoningEffort: "high,low", toolCount: 1.5 })).toEqual({})
})
