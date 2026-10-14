import { afterEach, expect, test } from "bun:test"
import { assertLogOrigin } from "./http"

const originalPublicUrl = process.env.RAWROUTE_PUBLIC_URL
const originalAllowedOrigins = process.env.RAWROUTE_ALLOWED_ORIGINS

afterEach(() => {
  if (originalPublicUrl === undefined) delete process.env.RAWROUTE_PUBLIC_URL
  else process.env.RAWROUTE_PUBLIC_URL = originalPublicUrl
  if (originalAllowedOrigins === undefined) delete process.env.RAWROUTE_ALLOWED_ORIGINS
  else process.env.RAWROUTE_ALLOWED_ORIGINS = originalAllowedOrigins
})

test("allows configured origins, including explicitly trusted cross-site requests", () => {
  process.env.RAWROUTE_PUBLIC_URL = "https://rawroute.tail8da2f2.ts.net"
  process.env.RAWROUTE_ALLOWED_ORIGINS = "http://localhost:8080, http://127.0.0.1:8080,https://rawroute.r45.qzz.io"
  for (const origin of [process.env.RAWROUTE_PUBLIC_URL, "http://localhost:8080", "http://127.0.0.1:8080", "https://rawroute.r45.qzz.io"]) {
    expect(assertLogOrigin(new Request("http://localhost:8080/api/logs", { headers: { origin, "sec-fetch-site": "cross-site" } }))).toBeUndefined()
  }
  for (const origin of ["https://untrusted.example", "http://localhost:9999", "null", "https://rawroute.r45.qzz.io.evil.example"]) {
    expect(assertLogOrigin(new Request("http://localhost:8080/api/logs", { headers: { origin } }))?.status).toBe(403)
  }
  expect(assertLogOrigin(new Request("http://localhost:8080/api/logs"))?.status).toBe(403)
})

test("retains same-origin fallback when no origin configuration is set", () => {
  delete process.env.RAWROUTE_PUBLIC_URL
  delete process.env.RAWROUTE_ALLOWED_ORIGINS
  expect(assertLogOrigin(new Request("http://localhost:8080/api/logs", { headers: { origin: "http://localhost:8080" } }))).toBeUndefined()
})
