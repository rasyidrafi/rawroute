import { expect, test } from "bun:test"
import { notFoundResponse } from "./not-found"

for (const path of ["/missing-page", "/dashboard/ai/usage", "/dashboard/missing"]) {
  test(`missing browser page ${path} returns a complete HTML 404`, async () => {
    const response = notFoundResponse(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }))
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toContain("text/html")
    const body = await response.text()
    expect(body).toContain("<!doctype html>")
    expect(body).toContain("Page not found")
    expect(body).toContain('href="/dashboard/ai/overview"')
    expect(body).not.toContain("<script")
  })
}

for (const path of ["/api/missing", "/v0/management/missing", "/v1/missing", "/v1beta/missing", "/openai/missing", "/backend-api/missing", "/executor/missing", "/model/missing"]) {
  test(`missing API ${path} stays JSON even in a browser`, async () => {
    const response = notFoundResponse(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }))
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual({ error: { message: "Not found." } })
  })
}

test("HEAD returns HTML metadata without a body", async () => {
  const response = notFoundResponse(new Request("http://localhost/dashboard/missing", { method: "HEAD" }))
  expect(response.status).toBe(404)
  expect(response.headers.get("content-type")).toContain("text/html")
  expect(await response.text()).toBe("")
})

test("non-page requests retain JSON errors", () => {
  for (const request of [new Request("http://localhost/missing.js"), new Request("http://localhost/dashboard/missing", { method: "POST" })]) {
    expect(notFoundResponse(request).headers.get("content-type")).toContain("application/json")
  }
})
