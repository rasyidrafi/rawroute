import { expect, test } from "bun:test"
import { declareRoute, validateServerRoutes, type ServerRouteDeclaration } from "../../packages/platform/src/contracts/http"

const handlers = { GET: () => new Response("ok") }
const route = (path: string) => declareRoute(handlers, "public", path)

test("route contributions accept static precedence, distinct methods and terminal wildcards", () => {
  expect(() => validateServerRoutes([
    { id: "platform", routes: [route("/health")] },
    { id: "gateway", routes: [route("/models/:id"), route("/models/fixed"), route("/v1/*"), declareRoute({ POST: () => new Response() }, "gateway", "/v1")] },
  ])).not.toThrow()
})

test("route composition rejects duplicate contribution IDs, paths and renamed parameter templates", () => {
  expect(() => validateServerRoutes([{ id: "ai", routes: [] }, { id: "ai", routes: [] }])).toThrow("Duplicate or empty route contribution")
  expect(() => validateServerRoutes([{ id: "ai", routes: [route("/v1"), route("/v1")] }])).toThrow("Duplicate route template")
  expect(() => validateServerRoutes([
    { id: "ai", routes: [route("/keys/:id")] },
    { id: "tools", routes: [declareRoute({ POST: () => new Response() }, "gateway", "/keys/:keyId")] },
  ])).toThrow("Duplicate route template")
})

test("route composition rejects missing policies and invalid methods even for untyped contributions", () => {
  const invalid = (value: unknown) => () => validateServerRoutes([{ id: "fixture", routes: [value as ServerRouteDeclaration] }])
  expect(invalid({ path: "/missing", handlers })).toThrow("Missing or invalid access policy")
  expect(invalid({ path: "/unknown", access: "admin", handlers })).toThrow("Missing or invalid access policy")
  expect(invalid({ path: "/empty", access: "public", handlers: {} })).toThrow("Invalid route methods")
  expect(invalid({ path: "/method", access: "public", handlers: { TRACE: handlers.GET } })).toThrow("Invalid route methods")
  expect(invalid({ path: "/handler", access: "public", handlers: { GET: true } })).toThrow("Invalid route methods")
})

test.each(["relative", "/path?query", "/path#hash", "/double//slash", "/wild/*/tail", "/partial*", "/:id/:id", "/:bad-name"]) ("route composition rejects invalid template %s", path => {
  expect(() => validateServerRoutes([{ id: "fixture", routes: [route(path)] }])).toThrow()
})

test("route-specific transport and password exceptions are validated", () => {
  expect(() => validateServerRoutes([{ id: "fixture", routes: [declareRoute(handlers, "public", "/public", { allowInitialPassword: true })] }])).toThrow("Initial-password exception requires session access")
  expect(() => validateServerRoutes([{ id: "fixture", routes: [declareRoute(handlers, "session", "/drain", { idleTimeout: 0, idleTimeoutMethods: ["DELETE"] })] }])).toThrow("Invalid idle timeout methods")
  expect(() => validateServerRoutes([{ id: "fixture", routes: [declareRoute({ GET: handlers.GET, DELETE: handlers.GET }, "session", "/drain", { idleTimeout: 0, idleTimeoutMethods: ["DELETE"] })] }])).not.toThrow()
})
