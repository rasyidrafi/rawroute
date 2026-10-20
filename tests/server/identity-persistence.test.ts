import "../../apps/console/src/server/composition"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { identity, createSession, isAuthenticated } from "../../packages/platform/src/server/runtime"
import { createIdentityRepository } from "../../packages/platform/src/server/identity"
import { closeLocalDatabase, getSqliteDatabase } from "../../packages/platform/src/server/database"
import { _resetMemoryBackend, listApiKeys, findIndexedApiKeyByValue, readRoutingData } from "../../packages/gateway-ai/src/server/store"
import { runInWorkspace } from "../../packages/platform/src/server/workspace-context"

beforeEach(async () => {
  await closeLocalDatabase()
  process.env.SQLITE_PATH = ":memory:"
  process.env.STORAGE_BACKEND = "sqlite"
  process.env.NODE_ENV = "development"
  process.env.DATABASE_COLLECTION_PREFIX = "identity_test"
  process.env.SESSION_SECRET = "identity-test-persisted-session-secret"
  process.env.DEFAULT_ADMIN_PASSWORD = "identity-test-password"
  _resetMemoryBackend()
  identity.reset()
})
afterEach(async () => { await closeLocalDatabase(); identity.reset() })

test("first metadata creation atomically seeds one indexed AI key and preserves the stored path", async () => {
  await Promise.all(Array.from({ length: 8 }, () => identity.readMeta()))
  const db = getSqliteDatabase()
  const stored = await db.collection("identity_test_system").doc("meta").get()
  expect(stored.data().version).toBe(4)
  expect(stored.data().sessionSecret).toBe(process.env.SESSION_SECRET)
  const keys = await runInWorkspace({ id: "default" }, () => listApiKeys())
  expect(keys).toHaveLength(1)
  expect((await findIndexedApiKeyByValue(keys[0]!.key))?.apiKey.id).toBe(keys[0]!.id)
  identity.reset()
  await identity.readMeta()
  expect(await runInWorkspace({ id: "default" }, () => listApiKeys())).toHaveLength(1)
  expect(await runInWorkspace({ id: "default" }, () => readRoutingData())).not.toHaveProperty("sessionSecret")
})

test("session and combo signing preserve the existing HMAC format without exposing secrets", async () => {
  expect(await identity.sign("combo-confirmation")).toBe(createHmac("sha256", process.env.SESSION_SECRET!).update("combo-confirmation").digest("base64url"))
  const cookie = (await createSession(new Request("https://console.test"))).split(";", 1)[0]!
  expect(await isAuthenticated(new Request("https://console.test", { headers: { cookie } }))).toBe(true)
  await identity.updateMeta(meta => { meta.sessionSecret = "rotated-persisted-session-secret" })
  expect(await isAuthenticated(new Request("https://console.test", { headers: { cookie } }))).toBe(false)
  identity.reset()
  expect((await identity.readMeta()).sessionSecret).toBe("rotated-persisted-session-secret")
})

test("bootstrap adapter failures roll back both metadata and contributed documents", async () => {
  const db = getSqliteDatabase()
  const repository = createIdentityRepository({
    validateBootstrap() {},
    initialize(transaction) {
      transaction.create(db.collection("bootstrap_contributions").doc("key"), { value: "seed" })
      throw new Error("bootstrap failed")
    },
    changed() {},
  })
  await expect(repository.readMeta()).rejects.toThrow("bootstrap failed")
  expect((await db.collection("identity_test_system").doc("meta").get()).exists).toBe(false)
  expect((await db.collection("bootstrap_contributions").doc("key").get()).exists).toBe(false)
})

test("failed administrator updates leave the persisted identity unchanged", async () => {
  const before = await identity.readMeta()
  await expect(identity.updateMeta(meta => {
    meta.admin.mustChangePassword = false
    throw new Error("reject update")
  })).rejects.toThrow("reject update")
  identity.reset()
  expect(await identity.readMeta()).toEqual(before)
})
