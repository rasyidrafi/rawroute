import { expect, test } from "bun:test"

import { GET } from "@/app/v1/route"

test("gateway root returns API information as JSON", async () => {
  const response = GET()
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("application/json")
  expect(await response.json()).toMatchObject({
    service: "rawroute",
    status: "ok",
    endpoints: { openaiResponses: "POST /v1/responses" },
  })
})
