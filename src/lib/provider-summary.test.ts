import { describe, expect, test } from "bun:test"

import { countProviderApiKeys } from "@/lib/provider-summary"
import type { ProviderApiKey } from "@/lib/types"

const keys: ProviderApiKey[] = [
  { id: "a", providerId: "openai", name: "A", key: "a", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "b", providerId: "openai", name: "B", key: "b", enabled: false, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "c", providerId: "anthropic", name: "C", key: "c", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" },
]

describe("provider API key summaries", () => {
  test("counts configured and enabled keys independently", () => {
    expect(countProviderApiKeys("openai", keys)).toEqual({ configured: 2, enabled: 1 })
    expect(countProviderApiKeys("missing", keys)).toEqual({ configured: 0, enabled: 0 })
  })
})
