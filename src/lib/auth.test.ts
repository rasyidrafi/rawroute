import { describe, expect, test } from "vitest"

import { isSecureSessionRequest } from "@/lib/auth"

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] || null }
}

describe("session cookie protocol detection", () => {
  test("keeps direct HTTP deployments usable", () => {
    expect(isSecureSessionRequest(headers({}))).toBe(false)
    expect(isSecureSessionRequest(headers({ "x-forwarded-proto": "http" }))).toBe(false)
  })

  test("marks cookies secure behind an HTTPS proxy", () => {
    expect(isSecureSessionRequest(headers({ "x-forwarded-proto": "https" }))).toBe(true)
    expect(isSecureSessionRequest(headers({ forwarded: "for=192.0.2.1;proto=https" }))).toBe(true)
  })

  test("uses the first forwarded protocol in a proxy chain", () => {
    expect(isSecureSessionRequest(headers({ "x-forwarded-proto": "https, http" }))).toBe(true)
    expect(isSecureSessionRequest(headers({ "x-forwarded-proto": "http, https" }))).toBe(false)
  })
})
