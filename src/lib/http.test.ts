import { expect, test } from "bun:test"

import { gatewayModelId } from "@/lib/http"

test("gateway model ID keeps the provider prefix independent from the model name", () => {
  expect(gatewayModelId("ht", "halotec-pro")).toBe("ht/halotec-pro")
  expect(gatewayModelId("ht", "other/Custom Model")).toBe("ht/custom-model")
  expect(gatewayModelId("ht", "halotec-pro", true)).toBe("halotec-pro")
})
