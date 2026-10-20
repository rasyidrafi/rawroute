import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { DEFAULT_ADMIN_PASSWORD } from "../contracts/auth-defaults"
import { getSqliteDatabase, type Transaction } from "./database"
import { collectionPrefix, isMemoryBackend } from "./storage-config"
import type { SignValue } from "../contracts/request-identity"
import { appendMemoryAudit, stageAudit } from "./audit"

export interface Meta {
  version: 4
  admin: { passwordHash: string; mustChangePassword: boolean }
  sessionSecret: string
}

export function assertIdentityBootstrap(environment: Record<string, string | undefined>) {
  const password = environment.DEFAULT_ADMIN_PASSWORD
  if (password && password.length < 10) throw new Error("DEFAULT_ADMIN_PASSWORD must be at least 10 characters.")
  if (!environment.SESSION_SECRET || environment.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be set to at least 32 characters before production initialization.")
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex")
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`
}

export function verifyPassword(password: string, stored: string) {
  const [salt, expectedHex] = stored.split(":")
  if (!salt || !expectedHex) return false
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function validatePasswordUpdate(currentPassword: string, newPassword: string, confirmPassword: string, storedHash: string) {
  if (!verifyPassword(currentPassword, storedHash)) throw new Error("Current password is incorrect.")
  if (newPassword === DEFAULT_ADMIN_PASSWORD) throw new Error("Choose a private password instead of the documented default.")
  if (newPassword.length < 10) throw new Error("New password must be at least 10 characters.")
  if (newPassword !== confirmPassword) throw new Error("New passwords do not match.")
  if (currentPassword === newPassword) throw new Error("New password must be different from the current password.")
}

export function createIdentityRepository(dependencies: {
  memory?: { value?: Meta }
  validateBootstrap(environment: Record<string, string | undefined>): void
  initialize(transaction: Transaction): void
  changed(transaction?: Transaction): void
}) {
  const memory = dependencies.memory || {}
  let cache: { value: Meta; expiresAt: number } | undefined
  let inflight: Promise<Meta> | undefined
  let generation = 0
  const configured = Number(process.env.ROUTING_CACHE_TTL_MS || 60_000)
  const ttl = Number.isFinite(configured) && configured >= 0 ? configured : 60_000
  const ref = () => getSqliteDatabase().collection(`${collectionPrefix()}_system`).doc("meta")
  function initial(): Meta {
    if (process.env.NODE_ENV === "production") {
      assertIdentityBootstrap(process.env)
      dependencies.validateBootstrap(process.env)
    }
    return { version: 4, admin: { passwordHash: hashPassword(process.env.DEFAULT_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD), mustChangePassword: true }, sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString("hex") }
  }
  function invalidate() {
    generation += 1
    cache = undefined
    inflight = undefined
  }
  async function readShared(): Promise<Meta> {
    if (isMemoryBackend()) {
      if (!memory.value) {
        const value = initial()
        appendMemoryAudit({ action: "identity.update", resource: "administrator", result: "success" })
        memory.value = value
      }
      return memory.value
    }
    if (cache && cache.expiresAt > Date.now()) return cache.value
    if (!inflight) {
      const revision = generation
      const promise = (async () => {
        const current = await ref().get()
        if (current.exists) return current.data() as Meta
        return getSqliteDatabase().runTransaction(async transaction => {
          const snapshot = await transaction.get(ref())
          if (snapshot.exists) return snapshot.data() as Meta
          const value = initial()
          transaction.create(ref(), value)
          stageAudit(transaction, { action: "identity.update", resource: "administrator", result: "success" })
          dependencies.initialize(transaction)
          return value
        })
      })().then(value => {
        if (value.version !== 4) throw new Error("System metadata is not in the canonical format.")
        if (revision === generation) cache = { value: structuredClone(value), expiresAt: Date.now() + ttl }
        return value
      }).finally(() => { if (inflight === promise) inflight = undefined })
      inflight = promise
    }
    return inflight
  }
  async function readMeta() { return structuredClone(await readShared()) }
  async function updateMeta(mutator: (meta: Meta) => void | Promise<void>) {
    let value: Meta
    if (isMemoryBackend()) {
      value = structuredClone(await readShared())
      const previousHash = value.admin.passwordHash
      await mutator(value)
      appendMemoryAudit({ action: value.admin.passwordHash !== previousHash ? "auth.password" : "identity.update", resource: "administrator", result: "success" })
      memory.value = value
    } else {
      value = await getSqliteDatabase().runTransaction(async transaction => {
        const snapshot = await transaction.get(ref())
        if (!snapshot.exists) throw new Error("System metadata is missing.")
        const next = snapshot.data() as Meta
        const previous = next.sessionSecret
        const previousHash = next.admin.passwordHash
        await mutator(next)
        transaction.set(ref(), next)
        stageAudit(transaction, { action: next.admin.passwordHash !== previousHash ? "auth.password" : "identity.update", resource: "administrator", result: "success" })
        if (next.sessionSecret !== previous) dependencies.changed(transaction)
        return next
      })
    }
    invalidate()
    cache = { value: structuredClone(value), expiresAt: Date.now() + ttl }
    dependencies.changed()
    return value
  }
  async function writeMeta(value: Meta) {
    if (isMemoryBackend()) {
      appendMemoryAudit({ action: "identity.update", resource: "administrator", result: "success" })
      memory.value = structuredClone(value)
    } else await getSqliteDatabase().runTransaction(async transaction => {
      transaction.set(ref(), value)
      stageAudit(transaction, { action: "identity.update", resource: "administrator", result: "success" })
    })
    invalidate()
    dependencies.changed()
  }
  const sign: SignValue = async (value) => {
    return createHmac("sha256", (await readShared()).sessionSecret).update(value).digest("base64url")
  }
  return { readMeta, updateMeta, writeMeta, sign, invalidate, reset() { memory.value = undefined; invalidate() } }
}
