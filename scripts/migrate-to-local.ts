import { loadEnvConfig } from "@next/env"
import { applicationDefault, cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type CollectionReference } from "firebase-admin/firestore"

import { closeLocalDatabase, deleteLocalDocuments, listLocalDocuments, upsertLocalDocuments } from "@/lib/local-db"

loadEnvConfig(process.cwd())

type MigratedDocument = { path: string; data: Record<string, unknown> }

const args = new Set(process.argv.slice(2))
const dryRun = args.has("--dry-run")
const verifyOnly = args.has("--verify-only")
const skipFirestore = args.has("--skip-firestore")
const batchSize = 200
const migrationSince = process.env.MIGRATION_SINCE || "2026-08-01T00:00:00.000Z"
const migrationSinceMs = Date.parse(migrationSince)
if (!Number.isFinite(migrationSinceMs)) throw new Error(`Invalid MIGRATION_SINCE: ${migrationSince}`)
const retiredGatewayKeyIds = new Set([
  "09f41154-9cc4-45c8-8ea9-8a8cde14b1e6",
  "0f66f287-bbb1-409e-a7b0-ddaccb1d8784",
])
const retiredGatewayKeyNames = new Set(["Unlimited GPT-5.3 Codex Spark", "CCS imported 18"])
const migrationOwnedGatewayKeyIds = new Set(["17eb22fe-83ac-4e4d-adca-71ebc84fae0e"])

function sourceValue(name: string, fallback?: string) {
  return process.env[`SOURCE_${name}`] || process.env[name] || fallback
}

function sourceFirestore() {
  const projectId = sourceValue("FIREBASE_PROJECT_ID") || sourceValue("GOOGLE_CLOUD_PROJECT") || sourceValue("GCLOUD_PROJECT")
  const clientEmail = sourceValue("FIREBASE_CLIENT_EMAIL")
  const privateKey = sourceValue("FIREBASE_PRIVATE_KEY")?.replaceAll("\\n", "\n")
  const app = getApps().length
    ? getApp()
    : initializeApp({ credential: projectId && clientEmail && privateKey ? cert({ projectId, clientEmail, privateKey }) : applicationDefault(), projectId })
  return getFirestore(app, sourceValue("FIRESTORE_DATABASE_ID", "(default)" )!)
}

function isFirestoreTimestamp(value: unknown): value is { toDate: () => Date } {
  return Boolean(value && typeof value === "object" && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function")
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value instanceof Date) return value.toISOString()
  if (isFirestoreTimestamp(value)) return value.toDate().toISOString()
  if (Buffer.isBuffer(value)) return value.toString("base64")
  if (Array.isArray(value)) return value.map(normalizeValue).filter((entry) => entry !== undefined)
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      const normalized = normalizeValue(entry)
      if (normalized !== undefined) result[key] = normalized
    }
    return result
  }
  return value
}

function canHaveChildCollections(path: string, prefix: string) {
  const segments = path.split("/")
  if (segments.length === 1) return path === prefix || path === `${prefix}_workspaces`
  if (segments.length === 3 && segments[2] === "providers" && (segments[0] === prefix || segments[0] === `${prefix}_workspaces`)) return true
  // The legacy API-key collection is nested below the historical
  // `${prefix}/apiKeys/apiKeys` document path. It is a real collection of
  // gateway keys, not a derived index, so it must be traversed as part of the
  // migration just like workspace API-key collections.
  if (segments.length === 3 && segments[0] === prefix && segments[1] === "apiKeys" && segments[2] === "apiKeys") return true
  return false
}

function collectionPathForDocument(path: string) {
  return path.slice(0, path.lastIndexOf("/"))
}

function isUsageEventsCollection(path: string, prefix: string) {
  return path === `${prefix}_usage_events` || path.endsWith("/usageEvents")
}

function isUsageRollupsCollection(path: string, prefix: string) {
  return path === `${prefix}_usage_rollups` || path.endsWith("/usageRollups")
}

function isUsageCollection(path: string, prefix: string) {
  return isUsageEventsCollection(path, prefix) || isUsageRollupsCollection(path, prefix)
}

function isUsageDocument(path: string, prefix: string) {
  return isUsageCollection(collectionPathForDocument(path), prefix)
}

function isMigrationOwnedDocument(path: string, prefix: string) {
  return path === `${prefix}/apiKeys/apiKeys/legacy-9router` || (path.startsWith(`${prefix}/apiKeys/apiKeys/`) && migrationOwnedGatewayKeyIds.has(path.slice(path.lastIndexOf("/") + 1)))
}

function isRetiredGatewayDocument(path: string, data: Record<string, unknown>, prefix: string) {
  if (path.startsWith(`${prefix}/apiKeys/apiKeys/`)) {
    const id = path.slice(path.lastIndexOf("/") + 1)
    if (retiredGatewayKeyIds.has(id) || (typeof data.name === "string" && retiredGatewayKeyNames.has(data.name.trim()))) return true
  }
  if (!path.startsWith(`${prefix}_`) && !path.startsWith(`${prefix}/`)) return false
  return retiredGatewayKeyIds.has(String(data.gatewayKeyId || "")) || retiredGatewayKeyIds.has(String(data.apiKeyId || ""))
}

async function collectCollection(collection: CollectionReference, output: MigratedDocument[], prefix: string) {
  const snapshot = isUsageEventsCollection(collection.path, prefix)
    ? await collection.where("completedAt", ">=", new Date(migrationSinceMs).toISOString()).get()
    : isUsageRollupsCollection(collection.path, prefix)
      ? await collection.where("bucketStart", ">=", new Date(migrationSinceMs).toISOString()).get()
      : await collection.get()
  if (!canHaveChildCollections(collection.path, prefix)) {
    for (const document of snapshot.docs) output.push({ path: document.ref.path, data: normalizeValue(document.data()) as Record<string, unknown> })
    return
  }
  for (const document of snapshot.docs) {
    output.push({ path: document.ref.path, data: normalizeValue(document.data()) as Record<string, unknown> })
    const children = await document.ref.listCollections()
    for (const child of children) await collectCollection(child, output, prefix)
  }
}

async function collectFirestoreDocuments() {
  const db = sourceFirestore()
  const prefix = (sourceValue("FIRESTORE_COLLECTION_PREFIX", "rawroute") || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")
  const collections = await db.listCollections()
  const output: MigratedDocument[] = []
  for (const collection of collections) {
    if (collection.id !== prefix && !collection.id.startsWith(`${prefix}_`)) continue
    await collectCollection(collection, output, prefix)
  }
  // The original legacy API-key collection is an orphaned subcollection:
  // its parent `rawroute/apiKeys` document has no fields, so Firestore does
  // not return `rawroute` from listCollections(). Address the known path
  // explicitly or the real gateway keys disappear from a migration snapshot.
  const legacyApiKeys = db.collection(prefix).doc("apiKeys").collection("apiKeys")
  if (!output.some((document) => document.path.startsWith(`${legacyApiKeys.path}/`))) {
    await collectCollection(legacyApiKeys, output, prefix)
  }
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`
  return JSON.stringify(value)
}

const migrationDateFields = ["createdAt", "updatedAt", "completedAt", "startedAt", "bucketStart", "lastUsedAt", "lastEventAt", "expiresAt"]

function isStructuralDocument(path: string, prefix: string) {
  const collectionPath = path.slice(0, path.lastIndexOf("/"))
  return collectionPath === `${prefix}_system` || collectionPath === `${prefix}_workspace_name_indexes`
}

function isDerivedApiKeyIndex(path: string, prefix: string) {
  return path.slice(0, path.lastIndexOf("/")) === `${prefix}_api_key_indexes`
}

function isWithinMigrationWindow(document: MigratedDocument, prefix: string) {
  const collectionPath = collectionPathForDocument(document.path)
  // API-key indexes are derived from workspace API-key documents. Importing
  // the historical source index would resurrect orphaned rows, so the local
  // backfill remains the sole source of truth for this collection.
  if (isDerivedApiKeyIndex(document.path, prefix)) return false
  if (isUsageRollupsCollection(collectionPath, prefix)) {
    return typeof document.data.bucketStart === "string" && Date.parse(document.data.bucketStart) >= migrationSinceMs
  }
  if (isUsageEventsCollection(collectionPath, prefix)) {
    const completedAt = typeof document.data.completedAt === "string" ? Date.parse(document.data.completedAt) : NaN
    const startedAt = typeof document.data.startedAt === "string" ? Date.parse(document.data.startedAt) : NaN
    return [completedAt, startedAt].some((timestamp) => Number.isFinite(timestamp) && timestamp >= migrationSinceMs)
  }
  // Configuration, workspace, credential, pricing, budget, log, and system
  // documents are not historical usage rows. They must be copied regardless
  // of their age or an existing workspace setup can silently disappear.
  if (!isUsageCollection(collectionPath, prefix)) return true
  const timestamps = migrationDateFields
    .map((field) => document.data[field])
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
  // Structural identity/index documents do not carry a domain timestamp but
  // are required for login and key/workspace lookup. Historical event/config
  // documents must have at least one timestamp on or after the cutoff.
  return timestamps.some((timestamp) => timestamp >= migrationSinceMs) || (!timestamps.length && isStructuralDocument(document.path, prefix))
}

async function migrateFirestore() {
  const prefix = (sourceValue("FIRESTORE_COLLECTION_PREFIX", "rawroute") || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")
  const initialSourceAll = await collectFirestoreDocuments()
  let sourceAll = initialSourceAll
  let source = sourceAll.filter((document) => !isRetiredGatewayDocument(document.path, document.data, prefix) && isWithinMigrationWindow(document, prefix))
  const targetBefore = await listLocalDocuments()
  const compare = (sourceDocuments: MigratedDocument[], targetDocuments: Array<{ path: string; data: Record<string, unknown> }>) => {
    const targetByPath = new Map(targetDocuments.map((document) => [document.path, document.data]))
    let missing = 0
    let mismatched = 0
    for (const document of sourceDocuments) {
      const current = targetByPath.get(document.path)
      if (!current) missing += 1
      else if (stable(current) !== stable(document.data)) mismatched += 1
    }
    const sourcePaths = new Set(sourceDocuments.map((document) => document.path))
    const extra = targetDocuments.filter((document) =>
      !sourcePaths.has(document.path) &&
      !isDerivedApiKeyIndex(document.path, prefix) &&
      !isMigrationOwnedDocument(document.path, prefix) &&
      (!isUsageDocument(document.path, prefix) || isRetiredGatewayDocument(document.path, document.data, prefix)),
    ).length
    return { targetByPath, missing, mismatched, extra }
  }

  const before = compare(source, targetBefore)
  let totalDocumentsToWrite = 0
  let migrationPasses = 0
  let finalTarget = targetBefore
  let finalComparison = before
  if (!verifyOnly && !dryRun) {
    // Firestore is live while a migration runs. Re-read after each write pass
    // and converge a few times so the final parity check is against a fresh
    // source snapshot rather than only the snapshot used for the writes.
    for (let pass = 1; pass <= 3; pass += 1) {
      migrationPasses = pass
      const targetBeforePass = await listLocalDocuments()
      const comparisonBeforePass = compare(source, targetBeforePass)
      const documentsToWrite = source.filter((document) => {
        const current = comparisonBeforePass.targetByPath.get(document.path)
        return !current || stable(current) !== stable(document.data)
      })
      const sourcePaths = new Set(source.map((document) => document.path))
      const stalePaths = targetBeforePass
        .filter((document) =>
          !sourcePaths.has(document.path) &&
          !isDerivedApiKeyIndex(document.path, prefix) &&
          !isMigrationOwnedDocument(document.path, prefix) &&
          (!isUsageDocument(document.path, prefix) || isRetiredGatewayDocument(document.path, document.data, prefix)),
        )
        .map((document) => document.path)
      totalDocumentsToWrite += documentsToWrite.length
      for (let offset = 0; offset < documentsToWrite.length; offset += batchSize) {
        await upsertLocalDocuments(documentsToWrite.slice(offset, offset + batchSize))
        process.stdout.write(`Migrated PostgreSQL documents ${Math.min(offset + batchSize, documentsToWrite.length)}/${documentsToWrite.length}\n`)
      }
      for (let offset = 0; offset < stalePaths.length; offset += batchSize) {
        await deleteLocalDocuments(stalePaths.slice(offset, offset + batchSize))
        process.stdout.write(`Removed PostgreSQL documents older than cutoff ${Math.min(offset + batchSize, stalePaths.length)}/${stalePaths.length}\n`)
      }

      sourceAll = await collectFirestoreDocuments()
      source = sourceAll.filter((document) => !isRetiredGatewayDocument(document.path, document.data, prefix) && isWithinMigrationWindow(document, prefix))
      finalTarget = await listLocalDocuments()
      finalComparison = compare(source, finalTarget)
      if (finalComparison.missing === 0 && finalComparison.mismatched === 0 && finalComparison.extra === 0) break
      if (pass === 3) throw new Error(`PostgreSQL migration did not converge after ${pass} passes: ${finalComparison.missing + finalComparison.mismatched} missing/mismatched and ${finalComparison.extra} stale documents.`)
    }
  } else {
    finalTarget = targetBefore
  }

  const derivedApiKeyIndexDocuments = finalTarget.filter((document) => isDerivedApiKeyIndex(document.path, prefix)).length
  console.log(JSON.stringify({
    storage: "postgres",
    migrationSince,
    sourceDocumentsTotal: initialSourceAll.length,
    sourceDocumentsInWindow: source.length,
    targetDocuments: finalTarget.length,
    documentsToWrite: totalDocumentsToWrite,
    missingBefore: before.missing,
    mismatchedBefore: before.mismatched,
    missingAfter: finalComparison.missing + finalComparison.mismatched,
    extraTargetDocuments: finalComparison.extra,
    staleTargetDocuments: finalComparison.extra,
    derivedApiKeyIndexDocuments,
    migrationPasses,
    dryRun,
    verifyOnly,
  }, null, 2))
  if (!dryRun && (finalComparison.missing > 0 || finalComparison.mismatched > 0 || finalComparison.extra > 0)) throw new Error(`PostgreSQL verification failed: ${finalComparison.missing + finalComparison.mismatched} missing/mismatched and ${finalComparison.extra} stale documents.`)
}

async function main() {
  try {
    if (!skipFirestore) await migrateFirestore()
  } finally {
    await closeLocalDatabase()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
