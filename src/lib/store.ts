import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

import type { AppData } from "@/lib/types"

const cacheTtlMs = Number(process.env.ROUTING_CACHE_TTL_MS || 10_000)
let cache: { data: AppData; expiresAt: number } | undefined
let memoryData: AppData | undefined

const documentedAdminPassword = "change-me-now"
const documentedProxyKey = "sk-local-change-me"

export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined).map((item) => stripUndefined(item)) as T
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, stripUndefined(item)])) as T
  }
  return value
}

export function assertProductionBootstrap(environment: Record<string, string | undefined>) {
  const adminPassword = environment.DEFAULT_ADMIN_PASSWORD
  const proxyKey = environment.DEFAULT_PROXY_API_KEY
  const sessionSecret = environment.SESSION_SECRET
  if (!adminPassword || adminPassword === documentedAdminPassword) {
    throw new Error("DEFAULT_ADMIN_PASSWORD must be set to a non-default value before production initialization.")
  }
  if (!proxyKey || proxyKey === documentedProxyKey) {
    throw new Error("DEFAULT_PROXY_API_KEY must be set to a non-default value before production initialization.")
  }
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters before production initialization.")
  }
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string) {
  const [salt, expectedHex] = stored.split(":")
  if (!salt || !expectedHex) return false
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function initialData(): AppData {
  if (process.env.NODE_ENV === "production") assertProductionBootstrap(process.env)
  return {
    version: 1,
    admin: {
      username: process.env.DEFAULT_ADMIN_USERNAME || "admin",
      passwordHash: hashPassword(process.env.DEFAULT_ADMIN_PASSWORD || documentedAdminPassword),
      mustChangePassword: true,
    },
    sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
    providers: [],
    models: [],
    apiKeys: [{
      id: crypto.randomUUID(),
      name: "Default local key",
      key: process.env.DEFAULT_PROXY_API_KEY || documentedProxyKey,
      createdAt: new Date().toISOString(),
    }],
  }
}

function stateDocument() {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replaceAll("\\n", "\n")
  const configuredServiceAccount = projectId && clientEmail && privateKey
  const app = getApps().length ? getApp() : initializeApp({
    credential: configuredServiceAccount ? cert({ projectId, clientEmail, privateKey }) : applicationDefault(),
    projectId,
  })
  const firestore = getFirestore(app, process.env.FIRESTORE_DATABASE_ID || "(default)")
  const prefix = (process.env.FIRESTORE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")
  return firestore.collection(`${prefix}_system`).doc("state")
}

function isMemoryBackend() {
  return process.env.STORAGE_BACKEND === "memory" || process.env.NODE_ENV === "test"
}

export async function readData(): Promise<AppData> {
  if (cache && cache.expiresAt > Date.now()) return structuredClone(cache.data)

  if (isMemoryBackend()) {
    memoryData ||= initialData()
    return structuredClone(memoryData)
  }

  const reference = stateDocument()
  const data = await reference.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference)
    if (snapshot.exists) return snapshot.data() as AppData
    const created = initialData()
    transaction.create(reference, created)
    return created
  })
  cache = { data, expiresAt: Date.now() + cacheTtlMs }
  return structuredClone(data)
}

export async function writeData(data: AppData) {
  if (isMemoryBackend()) {
    memoryData = structuredClone(data)
  } else {
    await stateDocument().set(stripUndefined(data))
  }
  cache = { data: structuredClone(data), expiresAt: Date.now() + cacheTtlMs }
}

export async function updateData(mutator: (data: AppData) => void | Promise<void>) {
  if (isMemoryBackend()) {
    const data = await readData()
    await mutator(data)
    await writeData(data)
    return data
  }

  const reference = stateDocument()
  const result = await reference.firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference)
    const data = snapshot.exists ? snapshot.data() as AppData : initialData()
    await mutator(data)
    transaction.set(reference, stripUndefined(data))
    return data
  })
  cache = { data: structuredClone(result), expiresAt: Date.now() + cacheTtlMs }
  return result
}
