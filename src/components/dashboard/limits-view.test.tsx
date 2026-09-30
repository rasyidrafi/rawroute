import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ data: undefined as unknown, mutate: vi.fn() }))

vi.mock("swr", () => ({
  default: () => ({ data: mocks.data, mutate: mocks.mutate, isLoading: false, isValidating: false }),
}))

vi.mock("@/components/ui/dialog", async () => {
  const react = await import("react")
  return {
    Dialog: ({ children }: { children: ReactNode }) => react.createElement("div", null, children),
    DialogTrigger: ({ children }: { children: ReactNode }) => react.createElement("button", { type: "button" }, children),
    DialogContent: ({ children }: { children: ReactNode }) => react.createElement("section", { role: "dialog" }, children),
    DialogDescription: ({ children }: { children: ReactNode }) => react.createElement("p", null, children),
    DialogHeader: ({ children }: { children: ReactNode }) => react.createElement("header", null, children),
    DialogTitle: ({ children }: { children: ReactNode }) => react.createElement("h2", null, children),
  }
})

import { getCodexResetCreditSummary } from "@/components/dashboard/codex-reset-credits"
import { LimitsView } from "@/components/dashboard/limits-view"
import type { CodexUsageResult } from "@/lib/codex/usage"

const inventoryUsage: CodexUsageResult = {
  fetchedAt: "2026-09-30T00:00:00.000Z",
  stale: false,
  fiveHour: null,
  weekly: null,
  unusedResetCredits: 1,
  resetCredits: [{ id: "available-one", status: "available", expiresAt: "2030-01-01T00:00:00.000Z" }],
}

beforeEach(() => {
  mocks.data = { accounts: [{ id: "account-1", name: "Work account", enabled: true, usage: inventoryUsage }] }
  mocks.mutate.mockReset()
})

test("Limits renders reset count and the available-credit inventory without inventing history", () => {
  const markup = renderToStaticMarkup(createElement(LimitsView))

  expect(markup).toContain("1 available")
  expect(markup).toContain("Next expiry available")
  expect(markup).toContain("Reset credits")
  expect(markup).toContain(">available</p>")
  expect(markup).not.toContain("expired")
  expect(markup).not.toContain("redeemed")
  expect(getCodexResetCreditSummary(inventoryUsage, Date.parse("2029-12-31T00:00:00.000Z"))).toMatchObject({
    count: 1,
    nextExpiry: "2030-01-01T00:00:00.000Z",
  })
})

test("Limits retains the aggregate count and exposes the reset-credit inventory error", () => {
  const usage: CodexUsageResult = {
    fetchedAt: "2026-09-30T00:00:00.000Z",
    stale: false,
    fiveHour: null,
    weekly: null,
    unusedResetCredits: 3,
    resetCreditsError: "Inventory temporarily unavailable",
  }
  mocks.data = { accounts: [{ id: "account-1", name: "Work account", enabled: true, usage }] }

  const markup = renderToStaticMarkup(createElement(LimitsView))

  expect(markup).toContain("3 available")
  expect(markup).toContain("Inventory temporarily unavailable")
  expect(markup).not.toContain("No reset credits.")
})
