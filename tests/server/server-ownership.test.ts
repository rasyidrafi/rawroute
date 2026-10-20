import { expect, test } from "bun:test"
import { serverRouteContributions, apiRoutes } from "../../apps/console/src/server/routes"
import { platformServerRoutes } from "../../packages/platform/src/server/routes"
import { aiServerRoutes } from "../../packages/gateway-ai/src/server/routes"
import { toolsServerRoutes } from "../../packages/gateway-tools/src/server/routes"
import { observabilityServerRoutes } from "../../packages/platform/src/server/operational-logs/routes"
import { validateServerRoutes } from "../../packages/platform/src/contracts/http"

test("production uses all static owner contributions, with only composite health owned by console", () => {
  expect(serverRouteContributions.slice(0, 4)).toEqual([platformServerRoutes, aiServerRoutes, toolsServerRoutes, observabilityServerRoutes])
  expect(serverRouteContributions.map(item => [item.id, item.routes.length])).toEqual([["platform", 10], ["ai", 52], ["tools", 3], ["observability", 3], ["console", 2]])
  expect(() => validateServerRoutes(serverRouteContributions)).not.toThrow()
  expect(Object.keys(apiRoutes).sort()).toEqual(serverRouteContributions.flatMap(item => item.routes.map(route => route.path)).sort())
  expect(serverRouteContributions[4]!.routes.map(route => route.path).sort()).toEqual(["/api/health", "/api/live"])
})

test("public catalogs, usage, callbacks and global CLIProxy remain AI-owned; Tools remains global", () => {
  const ai = new Map(aiServerRoutes.routes.map(route => [route.path, route.access]))
  expect(ai.get("/api/admin/cliproxy/status")).toBe("session")
  expect(ai.get("/api/admin/cliproxy/service/:action")).toBe("session")
  expect(ai.get("/api/public/dashboard")).toBe("public")
  expect(ai.get("/api/public/usage/keys/:keyId")).toBe("public")
  expect(ai.get("/model/info")).toBe("public")
  expect(ai.get("/codex/callback")).toBe("public")
  expect(ai.get("/backend-api/codex/*")).toBe("gateway")
  expect(toolsServerRoutes.routes.map(route => [route.path, route.access])).toEqual([
    ["/api/admin/tool-gateway/status", "session"], ["/executor/api/*", "gateway"], ["/executor/api", "gateway"],
  ])
  expect(observabilityServerRoutes.routes.every(route => route.options?.operationalLog === "omit")).toBe(true)
})
