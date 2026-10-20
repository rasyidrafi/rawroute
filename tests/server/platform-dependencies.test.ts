import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assertBrowserBuildGraph, checkArchitecture, repository } from "../../scripts/check-architecture"

test("all workspace exports, declared dependencies, source layers and actual browser roots obey the resolved DAG", () => {
  expect(checkArchitecture().workspaces).toBe(6)
})

test("resolved negative fixtures reject relative, alias, type, export, dynamic and transitive browser/server bypasses", () => {
  const fixtures = [
    ["packages/platform/src/server/runtime.ts", 'export * from "@rawroute/gateway-ai/server"', /Undeclared/],
    ["packages/platform/src/server/runtime.ts", 'export * from "../../../gateway-ai/src/server/store"', /relative bypass/],
    ["packages/ui/src/utils.ts", 'export * from "@rawroute/platform/web"', /Undeclared/],
    ["packages/gateway-tools/src/server/runtime.ts", 'void import("@rawroute/gateway-ai/server")', /Undeclared/],
    ["packages/gateway-ai/src/contracts/pages.ts", 'type Secret = import("../server/store")', /server-only/],
    ["packages/platform/src/web/api.ts", 'export * from "../server/runtime"', /server-only/],
    ["packages/observability/src/contracts/timezone.ts", 'void process.env.SESSION_SECRET', /Server-only global/],
    ["packages/observability/src/contracts/timezone.ts", 'export * from "node:crypto"', /server-only external/],
    ["apps/console/src/server/composition.ts", 'export * from "@rawroute/gateway-ai/server/store"', /Private package/],
    ["packages/platform/src/server/runtime.ts", 'export * from "@/gateways/ai/server/store"', /Alias/],
    ["packages/ui/src/utils.ts", 'export * from "@rawroute/ui"', /Private package/],
    ["apps/console/src/server/composition.ts", 'export * from "@rawroute/gateway-ai/server/maintenance/identifiers"', /Console raw domain/],
    ["packages/platform/src/web/api.ts", 'void import("#private-server")', /Alias/],
  ] as const
  for (const [file, source, error] of fixtures) expect(() => checkArchitecture({ overrides: new Map([[join(repository, file), source]]) })).toThrow(error)
})

test("root package cannot expose mixed application exports", () => {
  const file = join(repository, "package.json")
  const manifest = JSON.parse(readFileSync(file, "utf8"))
  expect(() => checkArchitecture({ overrides: new Map([[file, JSON.stringify({ ...manifest, exports: { ".": "./apps/console/src/server/index.ts" } })]]) })).toThrow(/Mixed root package/)
})

test("actual-output graph guard follows lazy/shared chunks and rejects server inputs and native externals", () => {
  const frontend = "apps/console/src/frontend/frontend.tsx"
  const meta: Bun.BuildMetafile = {
    inputs: { [frontend]: { bytes: 1, imports: [] } },
    outputs: {
      "./browser.js": { bytes: 1, entryPoint: "apps/console/src/frontend/index.html", inputs: { [frontend]: { bytesInOutput: 1 } }, imports: [{ path: "./lazy.js", kind: "dynamic-import" }], exports: [] },
      "./lazy.js": { bytes: 1, inputs: {}, imports: [], exports: [] },
    },
  }
  expect(assertBrowserBuildGraph(meta).chunks).toBe(2)
  meta.outputs["./lazy.js"]!.inputs["packages/gateway-ai/src/server/store.ts"] = { bytesInOutput: 1 }
  expect(() => assertBrowserBuildGraph(meta)).toThrow(/server\/private source/)
  meta.outputs["./lazy.js"]!.inputs = {}
  meta.outputs["./lazy.js"]!.imports = [{ path: "node:crypto", kind: "import-statement" }]
  expect(() => assertBrowserBuildGraph(meta)).toThrow(/server-only dependency/)
})

test("manifest fixtures reject mixed root exports, wildcard exposure, wrong directions and undeclared dependencies", () => {
  const directory = join(repository, "packages/observability")
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
  for (const exports of [{ ".": "./src/contracts/index.ts" }, { "./*": "./src/*" }]) expect(() => checkArchitecture({ manifests: new Map([[directory, { ...manifest, exports }]]) })).toThrow(/Mixed root/)
  expect(() => checkArchitecture({ manifests: new Map([[directory, { ...manifest, dependencies: { "@rawroute/platform": "workspace:*" } }]]) })).toThrow(/Wrong-direction/)
  const platform = join(repository, "packages/platform")
  const platformManifest = JSON.parse(readFileSync(join(platform, "package.json"), "utf8"))
  expect(() => checkArchitecture({ manifests: new Map([[platform, { ...platformManifest, dependencies: {} }]]) })).toThrow(/Undeclared/)
  expect(() => checkArchitecture({ overrides: new Map([[join(repository, "tsconfig.json"), '{"compilerOptions":{"paths":{"@/*":["./packages/*/src"]}}}']]) })).toThrow(/aliases/)
})
