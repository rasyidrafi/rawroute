import { expect, test } from "vitest"
import { upstreamFailure } from "@/lib/upstream-failure"

test("extracts reset timing and safe code without logging sensitive message", async () => {
  const response = Response.json({ error: { type: "usage_limit_reached", message: "secret", resets_in_seconds: 600 } }, { status: 429 })
  expect(await upstreamFailure(response)).toEqual({ errorCode: "usage_limit_reached", retrySeconds: 600 })
  expect((await response.json()).error.message).toBe("secret")
})

test("opaque errors preserve fallback", async () => {
  expect(await upstreamFailure(new Response("invalid"))).toEqual({})
})
