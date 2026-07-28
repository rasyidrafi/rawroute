import { describe, expect, test } from "bun:test"

import { validateProviderHeaders } from "@/lib/provider-headers"

describe("provider static headers", () => {
  test("accepts legal string headers", () => {
    expect(validateProviderHeaders({ "anthropic-version": "2023-06-01", "x-tenant": "acme" }))
      .toEqual({ "anthropic-version": "2023-06-01", "x-tenant": "acme" })
  })

  test("rejects malformed names and non-string values", () => {
    expect(() => validateProviderHeaders({ "bad header": "value" })).toThrow("Invalid provider header name")
    expect(() => validateProviderHeaders({ "x-retries": 3 })).toThrow("must be a string")
    expect(() => validateProviderHeaders(["x-test"])).toThrow("JSON object")
  })

  test("rejects headers managed by the gateway or HTTP runtime", () => {
    for (const name of ["content-length", "authorization", "x-api-key", "cookie", "set-cookie", "host", "transfer-encoding"]) {
      expect(() => validateProviderHeaders({ [name]: "value" })).toThrow("reserved")
    }
  })
})
