import { expect, test } from "bun:test"
import { storageServerRoutes } from "../../packages/gateway-storage/src/server/routes"

const statusRoute = storageServerRoutes.routes.find(route => route.path === "/api/admin/storage/status")!

test("Storage availability is authenticated, global, and reports no deployment secrets", async () => {
  const previous = process.env.STORAGE_ENABLED
  try {
    expect(statusRoute.access).toBe("session")
    process.env.STORAGE_ENABLED = "false"
    const disabled = await statusRoute.handlers.GET!(new Request("http://localhost/api/admin/storage/status"), {})
    expect(disabled.headers.get("cache-control")).toBe("no-store")
    expect(await disabled.json()).toEqual({ state: "disabled" })

    process.env.STORAGE_ENABLED = "true"
    const enabled = await statusRoute.handlers.GET!(new Request("http://localhost/api/admin/storage/status"), {})
    expect(await enabled.json()).toEqual({ state: "available" })
    expect(statusRoute.path).toBe("/api/admin/storage/status")
  } finally {
    if (previous === undefined) delete process.env.STORAGE_ENABLED
    else process.env.STORAGE_ENABLED = previous
  }
})
