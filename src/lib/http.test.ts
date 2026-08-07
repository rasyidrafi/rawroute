import { expect, test } from "vitest"

import { cleanAliasId, gatewayModelId } from "@/lib/http"

test("gateway model ID keeps the provider prefix independent from the model name", () => {
  expect(gatewayModelId("ht", "halotec-pro")).toBe("ht/halotec-pro")
  expect(gatewayModelId("ht", "other/Custom Model")).toBe("ht/custom-model")
})

test("alias IDs preserve slash-delimited gateway model names", () => {
  expect(cleanAliasId("CX/GPT-5.6-Sol")).toBe("cx/gpt-5.6-sol")
  expect(cleanAliasId("cx//gpt-5.6-sol")).toBe("")
})
