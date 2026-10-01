import { afterEach, expect, test } from "bun:test"

import { _resetMemoryBackend, deleteCombo, listCombos, upsertCombo, upsertModel, upsertProvider } from "@/server/store"

afterEach(() => _resetMemoryBackend())

test("persists ordered combo members and rejects duplicate gateway IDs", async () => {
  const saved = await upsertCombo({ combo: "coding-fallback", name: "Coding fallback", members: ["p/a", "p/b"].map(modelId => ({ modelId, reasoning: { mode: "inherit" as const } })) })
  expect(saved.members.map(member => member.modelId)).toEqual(["p/a", "p/b"])
  await expect(upsertCombo({ combo: "CODING-FALLBACK", name: "Duplicate", members: ["p/a", "p/b"].map(modelId => ({ modelId, reasoning: { mode: "inherit" as const } })) })).rejects.toThrow("Combo gateway ID is already in use.")

  const updated = await upsertCombo({ originalId: saved.id, name: "Reordered", members: ["p/b", "p/a"].map(modelId => ({ modelId, reasoning: { mode: "inherit" as const } })) })
  expect(updated.members.map(member => member.modelId)).toEqual(["p/b", "p/a"])
  await deleteCombo(saved.id)
  expect(await listCombos()).toEqual([])
})

test("normalizes combo IDs and reserves them against later models", async () => {
  const combo = await upsertCombo({ combo: "p//new", name: "Fallback", members: ["p/a", "p/b"].map(modelId => ({ modelId, reasoning: { mode: "inherit" as const } })) })
  expect(combo.combo).toBe("p/new")

  const provider = await upsertProvider({ name: "Provider", prefix: "p", baseUrl: "https://api.example.com", protocol: "openai-chat", authType: "bearer", headers: {}, enabled: true })
  await expect(upsertModel(provider.id, { gatewayModelId: "p/new", name: "New", upstreamModel: "new", enabled: true })).rejects.toThrow("Gateway model ID is already in use.")
})

test("rejects a provider prefix change that would collide with a combo", async () => {
  const provider = await upsertProvider({ name: "Provider", prefix: "p", baseUrl: "https://api.example.com", protocol: "openai-chat", authType: "bearer", headers: {}, enabled: true })
  await upsertModel(provider.id, { gatewayModelId: "p/new", name: "New", upstreamModel: "new", enabled: true })
  await upsertCombo({ combo: "q/new", name: "Fallback", members: ["p/a", "p/b"].map(modelId => ({ modelId, reasoning: { mode: "inherit" as const } })) })

  await expect(upsertProvider({ originalId: provider.id, name: "Provider", prefix: "q", baseUrl: "https://api.example.com", protocol: "openai-chat", authType: "bearer", headers: {}, enabled: true })).rejects.toThrow("Gateway model ID is already in use.")
})
