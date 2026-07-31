import { applicationDefault, getApp, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required")
if (!process.env.GOOGLE_CLOUD_PROJECT) throw new Error("GOOGLE_CLOUD_PROJECT is required")
if (!process.env.FIRESTORE_DATABASE_ID) throw new Error("FIRESTORE_DATABASE_ID is required")
if (!process.env.FIRESTORE_COLLECTION_PREFIX?.includes("integration")) {
  throw new Error("Use an isolated FIRESTORE_COLLECTION_PREFIX containing 'integration'")
}

const app = getApps().length ? getApp() : initializeApp({
  credential: applicationDefault(),
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
})
const firestore = getFirestore(app, process.env.FIRESTORE_DATABASE_ID)
const prefix = process.env.FIRESTORE_COLLECTION_PREFIX.replace(/[^a-zA-Z0-9_-]/g, "_")

async function deleteCollection(path: string) {
  await firestore.recursiveDelete(firestore.collection(path))
}

await deleteCollection(`${prefix}_system`)
await deleteCollection(`${prefix}`)

const childEnvironment = {
  ...process.env,
  NODE_ENV: "production",
  DEFAULT_ADMIN_PASSWORD: "integration-admin-password",
  DEFAULT_PROXY_API_KEY: "sk-integration-gateway-key",
  SESSION_SECRET: "integration-session-secret-32-bytes-minimum",
}
const workers = Array.from({ length: 4 }, () => Bun.spawn([
  "bun", "-e", "import { readMeta, listProviders } from './src/lib/store.ts'; await readMeta(); await listProviders()",
], { cwd: process.cwd(), env: childEnvironment, stdout: "pipe", stderr: "pipe" }))
const exitCodes = await Promise.all(workers.map((worker) => worker.exited))
if (exitCodes.some((code) => code !== 0)) throw new Error("Concurrent Firestore initialization failed")

const { readMeta, updateMeta, listProviders, upsertProvider } = await import("../src/lib/store")
const before = await readMeta()
await updateMeta((meta) => { meta.admin.username = `smoke-${crypto.randomUUID()}` })
const after = await readMeta()
if (after.admin.username === before.admin.username) throw new Error("Firestore update was not readable")

await upsertProvider({
  name: "Smoke provider",
  prefix: "smoke",
  baseUrl: "https://example.com/v1",
  protocol: "openai-chat",
  authType: "none",
  headers: {},
  enabled: true,
})
const providers = await listProviders()
if (!providers.find((provider) => provider.prefix === "smoke")) throw new Error("Provider upsert not visible")

await deleteCollection(`${prefix}`)
await deleteCollection(`${prefix}_system`)

console.log(JSON.stringify({
  ok: true,
  database: process.env.FIRESTORE_DATABASE_ID,
  concurrentInitializers: workers.length,
  initialized: Boolean(before.version),
  cleanedUp: true,
}))
