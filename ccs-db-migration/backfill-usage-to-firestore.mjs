import { cert, getApp, getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { createHash } from "node:crypto"

const inputChunks = []
for await (const chunk of process.stdin) inputChunks.push(chunk)
const input = JSON.parse(Buffer.concat(inputChunks))
const write = process.argv.includes("--write")
const pruneHourly = process.argv.includes("--prune-hourly")
const hourlyOnly = process.argv.includes("--hourly-only")
const keptGranularities = hourlyOnly ? new Set(["hourly"]) : new Set(["daily", "monthly"])

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").split("\\n").join("\n")
const app = getApps().length
  ? getApp()
  : initializeApp({ credential: cert({ projectId, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey }) })
const db = getFirestore(app, process.env.FIRESTORE_DATABASE_ID || "(default)")
const prefix = (process.env.FIRESTORE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")

const digest = (value) => createHash("sha256").update(value).digest("hex")
const normalizeNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0
const normalizeCount = (value) => Math.max(0, Math.round(normalizeNumber(value)))
const normalizeCostMicros = (value) => Math.round(Math.max(0, normalizeNumber(value)) * 1_000_000)

const workspaces = await db.collection(`${prefix}_workspaces`).get()
const keyOwners = []
for (const workspaceDoc of workspaces.docs) {
  const keys = await workspaceDoc.ref.collection("apiKeys").get()
  for (const keyDoc of keys.docs) {
    const key = String(keyDoc.data().key || "")
    keyOwners.push({
      workspaceId: workspaceDoc.id,
      workspaceName: String(workspaceDoc.data().name || workspaceDoc.id),
      apiKeyId: keyDoc.id,
      keyHash: digest(key),
    })
  }
}

// The current Default workspace still uses the legacy storage layout. Discover
// that rather than assuming it from an environment variable.
const legacyKeys = await db.collection(prefix).doc("apiKeys").collection("apiKeys").get()
for (const keyDoc of legacyKeys.docs) {
  const key = String(keyDoc.data().key || "")
  keyOwners.push({ workspaceId: "default", workspaceName: "Default", apiKeyId: keyDoc.id, keyHash: digest(key) })
}

const findOwner = (keyRef) => {
  const value = String(keyRef || "").replace(/^api-key:/, "")
  return keyOwners.find((owner) => owner.keyHash.startsWith(value))
}

const defaultIsLegacy = legacyKeys.size > 0
const workspaceDocs = new Map(workspaces.docs.map((doc) => [doc.id, doc]))
const rollupsRef = (workspaceId) => {
  if (workspaceId === "default" && defaultIsLegacy) return db.collection(`${prefix}_usage_rollups`)
  const workspaceDoc = workspaceDocs.get(workspaceId)
  if (!workspaceDoc) throw new Error(`Workspace ${workspaceId} was not found`)
  return workspaceDoc.ref.collection("usageRollups")
}

const byWorkspace = new Map()
const unmatched = new Map()
const validRows = []
for (const row of input.rows || []) {
  const owner = findOwner(row.keyRef)
  if (!owner) {
    unmatched.set(row.keyRef, (unmatched.get(row.keyRef) || 0) + 1)
    continue
  }
  const bucketStart = new Date(row.bucketStart)
  if (!Number.isFinite(bucketStart.getTime())) continue
  const granularity = keptGranularities.has(row.granularity) ? row.granularity : null
  if (!granularity || !row.model) continue
  const requests = normalizeCount(row.requests)
  if (!requests) continue
  const inputTokens = normalizeCount(row.inputTokens)
  const outputTokens = normalizeCount(row.outputTokens)
  const cacheReadTokens = normalizeCount(row.cacheReadTokens)
  const cacheCreationTokens = normalizeCount(row.cacheCreationTokens)
  const totalTokens = inputTokens + outputTokens
  const costMicros = normalizeCostMicros(row.cost)
  const pricedRequests = Math.min(requests, normalizeCount(row.pricedRequests))
  const unpricedRequests = Math.max(0, requests - pricedRequests)
  const modelHash = digest(String(row.model)).slice(0, 16)
  const keyHash = digest(String(row.keyRef)).slice(0, 16)
  const normalizedBucket = bucketStart.toISOString()
  const id = `${granularity}:${normalizedBucket}:ccs-backfill-v1:${keyHash}:${modelHash}`
  const record = {
    id,
    granularity,
    bucketStart: normalizedBucket,
    gatewayKeyId: owner.apiKeyId,
    gatewayModelId: String(row.model),
    requests,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    costMicros,
    pricedRequests,
    unpricedRequests,
    lastEventAt: row.lastEventAt ? new Date(row.lastEventAt).toISOString() : normalizedBucket,
    updatedAt: input.generatedAt || new Date().toISOString(),
    backfillSource: "ccs-usage-v2",
  }
  validRows.push({ owner, record })
  const workspace = byWorkspace.get(owner.workspaceId) || { name: owner.workspaceName, rows: 0, requests: 0, tokens: 0, costMicros: 0, granularities: { hourly: 0, daily: 0, monthly: 0 } }
  workspace.rows += 1
  workspace.requests += requests
  workspace.tokens += totalTokens
  workspace.costMicros += costMicros
  workspace.granularities[granularity] += 1
  byWorkspace.set(owner.workspaceId, workspace)
}

const existingBackfill = {}
const hourlyBackfillRefs = new Map()
for (const [workspaceId] of byWorkspace) {
  const snapshot = await rollupsRef(workspaceId).get()
  const backfillDocs = snapshot.docs.filter((doc) => doc.data().backfillSource === "ccs-usage-v2")
  existingBackfill[workspaceId] = {
    total: backfillDocs.length,
    daily: backfillDocs.filter((doc) => doc.data().granularity === "daily").length,
    monthly: backfillDocs.filter((doc) => doc.data().granularity === "monthly").length,
    hourly: backfillDocs.filter((doc) => doc.data().granularity === "hourly").length,
  }
  hourlyBackfillRefs.set(workspaceId, backfillDocs.filter((doc) => doc.data().granularity === "hourly").map((doc) => doc.ref))
}

if (write) {
  const batches = new Map()
  for (const { owner, record } of validRows) {
    let batch = batches.get(owner.workspaceId)
    if (!batch) {
      batch = { writes: [], ref: rollupsRef(owner.workspaceId) }
      batches.set(owner.workspaceId, batch)
    }
    batch.writes.push(record)
  }
  for (const { ref, writes } of batches.values()) {
    for (let offset = 0; offset < writes.length; offset += 400) {
      const batch = db.batch()
      for (const record of writes.slice(offset, offset + 400)) {
        batch.set(ref.doc(record.id), record, { merge: false })
      }
      await batch.commit()
    }
  }
  if (pruneHourly) {
    for (const refs of hourlyBackfillRefs.values()) {
      for (let offset = 0; offset < refs.length; offset += 400) {
        const batch = db.batch()
        for (const ref of refs.slice(offset, offset + 400)) batch.delete(ref)
        await batch.commit()
      }
    }
  }
}

console.log(JSON.stringify({
  mode: write ? "write" : "dry-run",
  hourlyOnly,
  keepGranularities: [...keptGranularities],
  pruneHourly,
  sourceRows: input.rows?.length || 0,
  matchedRows: validRows.length,
  unmatchedKeyRefs: [...unmatched.entries()].map(([keyRef, rows]) => ({ keyRef, rows })),
  existingBackfill,
  byWorkspace: Object.fromEntries([...byWorkspace.entries()].map(([id, value]) => [id, {
    ...value,
    costUsd: value.costMicros / 1_000_000,
  }])),
  written: write ? validRows.length : 0,
}, null, 2))
