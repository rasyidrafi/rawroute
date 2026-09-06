import { afterEach, expect, test } from "vitest"

import { _resetMemoryBackend, deleteCombo, listCombos, upsertCombo, upsertModel, upsertProvider } from "@/lib/store"

afterEach(() => _resetMemoryBackend())

test("persists ordered combo members and rejects duplicate gateway IDs", async () => {
  const saved = await upsertCombo({ combo: "coding-fallback", name: "Coding fallback", memberModelIds: ["p/a", "p/b"] })
  expect(saved.memberModelIds).toEqual(["p/a", "p/b"])
  await expect(upsertCombo({ combo: "CODING-FALLBACK", name: "Duplicate", memberModelIds: ["p/a", "p/b"] })).rejects.toThrow("Combo gateway ID is already in use.")

  const updated = await upsertCombo({ originalId: saved.id, name: "Reordered", memberModelIds: ["p/b", "p/a"] })
  expect(updated.memberModelIds).toEqual(["p/b", "p/a"])
  await deleteCombo(saved.id)
  expect(await listCombos()).toEqual([])
})

test("normalizes combo IDs and reserves them against later models", async () => {
  const combo = await upsertCombo({ combo: "p//new", name: "Fallback", memberModelIds: ["p/a", "p/b"] })
  expect(combo.combo).toBe("p/new")

  const provider = await upsertProvider({ name: "Provider", prefix: "p", baseUrl: "https://api.example.com", protocol: "openai-chat", authType: "bearer", headers: {}, enabled: true })
  await expect(upsertModel(provider.id, { gatewayModelId: "p/new", name: "New", upstreamModel: "new", enabled: true })).rejects.toThrow("Gateway model ID is already in use.")
})

test("rejects a provider prefix change that would collide with a combo", async () => {
  const provider = await upsertProvider({ name: "Provider", prefix: "p", baseUrl: "https://api.example.com", protocol: "openai-chat", authType: "bearer", headers: {}, enabled: true })
  await upsertModel(provider.id, { gatewayModelId: "p/new", name: "New", upstreamModel: "new", enabled: true })
  await upsertCombo({ combo: "q/new", name: "Fallback", memberModelIds: ["p/a", "p/b"] })

  await expect(upsertProvider({ originalId: provider.id, name: "Provider", prefix: "q", baseUrl: "https://api.example.com", protocol: "openai-chat", authType: "bearer", headers: {}, enabled: true })).rejects.toThrow("Gateway model ID is already in use.")
})
