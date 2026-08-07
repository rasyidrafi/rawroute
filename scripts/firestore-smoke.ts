import { loadEnvConfig } from "@next/env"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { spawn } from "node:child_process"

loadEnvConfig(process.cwd())

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replaceAll("\\n", "\n")
const configuredServiceAccount = projectId && clientEmail && privateKey
if (!projectId) throw new Error("FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT is required")
if (!configuredServiceAccount && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error("Firebase service-account credentials are required")
}
if (!process.env.FIRESTORE_DATABASE_ID) throw new Error("FIRESTORE_DATABASE_ID is required")
if (!process.env.FIRESTORE_COLLECTION_PREFIX?.includes("integration")) {
  throw new Error("Use an isolated FIRESTORE_COLLECTION_PREFIX containing 'integration'")
}

const app = getApps().length ? getApp() : initializeApp({
  credential: configuredServiceAccount ? cert({ projectId, clientEmail, privateKey }) : applicationDefault(),
  projectId,
})
const firestore = getFirestore(app, process.env.FIRESTORE_DATABASE_ID)
const prefix = process.env.FIRESTORE_COLLECTION_PREFIX.replace(/[^a-zA-Z0-9_-]/g, "_")

async function deleteCollection(path: string) {
  await firestore.recursiveDelete(firestore.collection(path))
}

async function main() {
await deleteCollection(`${prefix}_system`)
await deleteCollection(`${prefix}`)
await deleteCollection(`${prefix}_workspaces`)
await deleteCollection(`${prefix}_workspace_name_indexes`)
await deleteCollection(`${prefix}_api_key_indexes`)

const childEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  DEFAULT_ADMIN_PASSWORD: "integration-admin-password",
  DEFAULT_PROXY_API_KEY: "sk-integration-gateway-key",
  SESSION_SECRET: "integration-session-secret-32-bytes-minimum",
}
const workers = Array.from({ length: 4 }, () => spawn(
  process.execPath,
  ["--import", "tsx", "--eval", "void import('./src/lib/store.ts').then(async ({ readMeta, listProviders }) => { await readMeta(); await listProviders() }).catch((error) => { console.error(error); process.exitCode = 1 })"],
  { cwd: process.cwd(), env: childEnvironment, stdio: "ignore" },
))
const exitCodes = await Promise.all(workers.map((worker) => new Promise<number | null>((resolve, reject) => {
  worker.once("error", reject)
  worker.once("exit", resolve)
})))
if (exitCodes.some((code) => code !== 0)) throw new Error("Concurrent Firestore initialization failed")

const { readMeta, updateMeta, listProviders, upsertProvider } = await import("../src/lib/store")
const { createApiKey, listApiKeys } = await import("../src/lib/store")
const { runInWorkspace } = await import("../src/lib/workspace-context")
const { createWorkspace, listWorkspaces, renameWorkspace } = await import("../src/lib/workspaces")
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

const defaultWorkspace = (await listWorkspaces()).find((workspace) => workspace.isDefault)
if (!defaultWorkspace) throw new Error("Default workspace was not initialized")
const isolated = await renameWorkspace((await createWorkspace("Smoke isolated")).id, "SMOKE ISOLATED")
await runInWorkspace(isolated, async () => {
  if ((await listProviders()).length) throw new Error("New workspace inherited providers")
  if ((await listApiKeys()).length) throw new Error("New workspace inherited gateway keys")
  await upsertProvider({ name: "Scoped provider", prefix: "smoke", baseUrl: "https://scoped.example/v1", protocol: "openai-chat", authType: "none", headers: {}, enabled: true })
  await createApiKey("Scoped key", "sk-integration-workspace-key")
})
if ((await runInWorkspace(defaultWorkspace, () => listProviders())).some((provider) => provider.name === "Scoped provider")) throw new Error("Workspace provider leaked into Default")
await runInWorkspace(defaultWorkspace, async () => {
  try {
    await createApiKey("Duplicate", "sk-integration-workspace-key")
    throw new Error("Cross-workspace gateway key collision was accepted")
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already in use")) throw error
  }
})

await deleteCollection(`${prefix}`)
await deleteCollection(`${prefix}_system`)
await deleteCollection(`${prefix}_workspaces`)
await deleteCollection(`${prefix}_workspace_name_indexes`)
await deleteCollection(`${prefix}_api_key_indexes`)

console.log(JSON.stringify({
  ok: true,
  database: process.env.FIRESTORE_DATABASE_ID,
  concurrentInitializers: workers.length,
  initialized: Boolean(before.version),
  cleanedUp: true,
}))
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
