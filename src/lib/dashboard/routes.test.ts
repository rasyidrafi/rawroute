import { expect, test } from "bun:test"
import { dashboardPageForPath, isPagePath, pagePaths, publicKeyUsagePagePath } from "./routes"

test("public key usage detail is one canonical browser route outside protected dashboard scopes", () => {
  expect(pagePaths.publicKeyUsage).toBe("/usage/keys/:keyId")
  expect(publicKeyUsagePagePath("opaque-id", "workspace_1")).toBe("/usage/keys/opaque-id?workspace=workspace_1")
  expect(isPagePath("/usage/keys/opaque-id")).toBe(true)
  expect(dashboardPageForPath("/usage/keys/opaque-id")).toBeUndefined()
})
