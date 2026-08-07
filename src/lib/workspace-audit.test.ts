import { expect, test } from "vitest"
import { readFileSync } from "node:fs"

test("authenticated catalog endpoints cannot cache one workspace for another", () => {
  const gatewayRoute = readFileSync(new URL("../app/v1/[...path]/route.ts", import.meta.url), "utf8")

  expect(gatewayRoute).toContain("proxyGatewayRequest")
  expect(gatewayRoute).not.toContain("max-age")
})
