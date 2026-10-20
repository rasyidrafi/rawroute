import { expect, test } from "bun:test"

import { gatewayModelId } from "../../packages/gateway-ai/src/server/model-identifiers"

test("gateway model ID keeps the provider prefix independent from the model name", () => {
  expect(gatewayModelId("ht", "halotec-pro")).toBe("ht/halotec-pro")
  expect(gatewayModelId("ht", "other/Custom Model")).toBe("ht/custom-model")
})
