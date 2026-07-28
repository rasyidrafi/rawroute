import { expect, test } from "bun:test"

import { catalogModels } from "@/lib/catalog"
import type { Model, Provider } from "@/lib/types"

const provider = { id: "p", prefix: "p", protocol: "openai-chat", enabled: true } as Provider
const model = { id: "p/model", providerId: "p", enabled: true, createdAt: "2026-01-01T00:00:00Z" } as Model

test("catalog excludes models whose provider is disabled or missing", () => {
  expect(catalogModels([{ ...provider, enabled: false }], [model])).toEqual([])
  expect(catalogModels([], [model])).toEqual([])
  expect(catalogModels([provider], [model])).toHaveLength(1)
})
