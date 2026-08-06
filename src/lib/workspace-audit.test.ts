import { expect, test } from "vitest"
import { readFileSync } from "node:fs"

test("authenticated catalog endpoints cannot cache one workspace for another", () => {
  const modelsRoute = readFileSync(new URL("../app/v1/models/route.ts", import.meta.url), "utf8")
  const infoRoute = readFileSync(new URL("../app/v1/model/info/route.ts", import.meta.url), "utf8")

  expect(modelsRoute).toContain('"cache-control": "private, no-store"')
  expect(infoRoute).toContain('"cache-control": "private, no-store"')
  expect(modelsRoute).not.toContain("max-age")
  expect(infoRoute).not.toContain("max-age")
})
