import { expect, test } from "bun:test"
import { createPlatformServer } from "../../packages/platform/src/server/runtime"

test("platform's actual service factory works with injected hooks and no gateway initialization", async () => {
  process.env.STORAGE_BACKEND = "memory"
  let changes = 0
  const create = () => createPlatformServer({
    identity: { initialize() {}, changed() { changes++ } },
    participants: [],
  })
  const a = create(), b = create()
  await a.identity.updateMeta(meta => { meta.admin.mustChangePassword = false })
  expect((await a.identity.readMeta()).admin.mustChangePassword).toBe(false)
  expect((await b.identity.readMeta()).admin.mustChangePassword).toBe(true)
  expect(changes).toBe(1)
  const cookie = (await a.createSession(new Request("http://localhost"))).split(";", 1)[0]!
  expect(await a.isAuthenticated(new Request("http://localhost", { headers: { cookie } }))).toBe(true)
  expect(await b.isAuthenticated(new Request("http://localhost", { headers: { cookie } }))).toBe(false)
})
