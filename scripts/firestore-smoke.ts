import { applicationDefault, getApp, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"

import { readData, updateData } from "../src/lib/store"

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
const collection = `${process.env.FIRESTORE_COLLECTION_PREFIX.replace(/[^a-zA-Z0-9_-]/g, "_")}_system`
const reference = firestore.collection(collection).doc("state")
await reference.delete()

const childEnvironment = {
  ...process.env,
  NODE_ENV: "production",
  DEFAULT_ADMIN_PASSWORD: "integration-admin-password",
  DEFAULT_PROXY_API_KEY: "sk-integration-gateway-key",
  SESSION_SECRET: "integration-session-secret-32-bytes-minimum",
}
const workers = Array.from({ length: 4 }, () => Bun.spawn([
  "bun", "-e", "import { readData } from './src/lib/store.ts'; await readData()",
], { cwd: process.cwd(), env: childEnvironment, stdout: "pipe", stderr: "pipe" }))
const exitCodes = await Promise.all(workers.map((worker) => worker.exited))
if (exitCodes.some((code) => code !== 0)) throw new Error("Concurrent Firestore initialization failed")

const marker = `smoke-${crypto.randomUUID()}`
const before = await readData()
await updateData((data) => { data.admin.username = marker })
const after = await readData()
if (after.admin.username !== marker) throw new Error("Firestore update was not readable")
await reference.delete()

console.log(JSON.stringify({
  ok: true,
  database: process.env.FIRESTORE_DATABASE_ID,
  concurrentInitializers: workers.length,
  initialized: Boolean(before.version),
  cleanedUp: true,
}))
