import { beforeEach, describe, expect, test } from "bun:test"

import { _resetMemoryBackend, deleteAlias, listAliases, readData, upsertAlias } from "@/lib/store"
import type { ModelAlias } from "@/lib/types"

beforeEach(() => {
  process.env.STORAGE_BACKEND = "memory"
  _resetMemoryBackend()
})

function aliasInput(overrides: Partial<ModelAlias> = {}): Partial<ModelAlias> & { originalId?: string } {
  return {
    alias: "my-cool-model",
    name: "My Cool Model",
    targetModelId: "openai/gpt-4o",
    originalId: undefined,
    ...overrides,
  }
}

describe("model aliases", () => {
  test("persists an alias and lists it by alias ascending", async () => {
    const saved = await upsertAlias(aliasInput())
    expect(saved.id).toBeTruthy()
    expect(saved.alias).toBe("my-cool-model")
    expect(saved.createdAt).toBeTruthy()

    await upsertAlias(aliasInput({ alias: "aaa-first", name: "ZZZ Display Name" }))
    const aliases = await listAliases()
    expect(aliases.map((entry) => entry.alias)).toEqual(["aaa-first", "my-cool-model"])
    expect((await readData()).aliases).toHaveLength(2)
  })

  test("normalizes the alias ID and rejects duplicates", async () => {
    await upsertAlias(aliasInput())
    await expect(upsertAlias(aliasInput({ alias: "MY-COOL-MODEL" }))).rejects.toThrow("Alias is already in use.")
  })

  test("rejects an alias with an empty alias ID", async () => {
    await expect(upsertAlias(aliasInput({ alias: "   " }))).rejects.toThrow("Alias is required.")
  })

  test("rejects an alias missing a target model", async () => {
    await expect(upsertAlias(aliasInput({ targetModelId: "" }))).rejects.toThrow("Alias target model is required.")
  })

  test("updates an existing alias without duplicating it", async () => {
    const saved = await upsertAlias(aliasInput())
    const updated = await upsertAlias({ ...aliasInput(), originalId: saved.id, name: "Renamed" })
    expect(updated.name).toBe("Renamed")
    expect(await listAliases()).toHaveLength(1)
  })

  test("deletes an alias", async () => {
    const saved = await upsertAlias(aliasInput())
    await deleteAlias(saved.id)
    expect(await listAliases()).toEqual([])
  })
})
