import { describe, expect, test } from "bun:test"

import { assertProductionBootstrap, hashPassword, readData, stripUndefined, updateData, validatePasswordUpdate, verifyPassword } from "@/lib/store"

describe("admin passwords", () => {
  test("stores a salted hash rather than the password", () => {
    const hash = hashPassword("a-strong-test-password")
    expect(hash).not.toContain("a-strong-test-password")
    expect(verifyPassword("a-strong-test-password", hash)).toBe(true)
  })

  test("rejects the wrong password", () => {
    const hash = hashPassword("correct-password")
    expect(verifyPassword("wrong-password", hash)).toBe(false)
  })

  test("validates current password and matching replacement", () => {
    const hash = hashPassword("current-password")
    expect(() => validatePasswordUpdate("wrong-password", "new-password-123", "new-password-123", hash)).toThrow("Current password is incorrect.")
    expect(() => validatePasswordUpdate("current-password", "new-password-123", "different-password", hash)).toThrow("New passwords do not match.")
    expect(() => validatePasswordUpdate("current-password", "new-password-123", "new-password-123", hash)).not.toThrow()
  })
})

describe("configuration storage", () => {
  test("removes undefined optional fields before Firestore writes", () => {
    const data = stripUndefined({
      providers: [{ id: "openai", authHeader: undefined, secret: undefined }],
      models: [{ id: "oa/test", protocol: undefined, upstreamPath: undefined }],
      nested: { keep: "value", omit: undefined },
    })

    expect(data).toEqual({
      providers: [{ id: "openai" }],
      models: [{ id: "oa/test" }],
      nested: { keep: "value" },
    })
  })

  test("persists an update through the test memory adapter", async () => {
    process.env.STORAGE_BACKEND = "memory"
    const before = await readData()
    await updateData((data) => { data.admin.username = "test-admin" })
    const after = await readData()
    expect(after.admin.username).toBe("test-admin")
    after.admin.username = "mutated-copy"
    expect((await readData()).admin.username).toBe("test-admin")
    await updateData((data) => { data.admin.username = before.admin.username })
  })
})

describe("production bootstrap", () => {
  test("rejects missing or documented default credentials", () => {
    expect(() => assertProductionBootstrap({})).toThrow()
    expect(() => assertProductionBootstrap({
      DEFAULT_ADMIN_PASSWORD: "change-me-now",
      DEFAULT_PROXY_API_KEY: "sk-local-change-me",
      SESSION_SECRET: "01234567890123456789012345678901",
    })).toThrow()
  })

  test("accepts explicitly configured non-default secrets", () => {
    expect(() => assertProductionBootstrap({
      DEFAULT_ADMIN_PASSWORD: "a-private-admin-password",
      DEFAULT_PROXY_API_KEY: "sk-private-gateway-key",
      SESSION_SECRET: "01234567890123456789012345678901",
    })).not.toThrow()
  })
})
