import { randomBytes, randomUUID } from "node:crypto"
import { getDatabase, withTransaction, type DocumentIntegration } from "@rawroute/platform/server/database"
import { appendAuditSqlite, type AuditAction, type AuditResource } from "@rawroute/platform/server/audit"
import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"
import { storageActions, storageKeyAllows, supportsStorageAction, type AttachedBucket, type CapabilityStatus, type StorageClientKey, type StorageConnection, type StorageDashboard, type StorageMultipart, type StorageAction } from "../contracts"
import { decryptStorageSecret, encryptStorageSecret, resolveStorageEndpoint, type EncryptedStorageSecret } from "./security"
import { storageEnabled, storageEncryptionKey, storageTrustedOrigins } from "./config"
import { assertStorageSchema } from "./schema"

const maximumMultipartUploads = 1000

export interface ConnectionRecord extends StorageConnection { credentials: EncryptedStorageSecret }
export interface KeyRecord extends StorageClientKey { secret: EncryptedStorageSecret }
export interface BucketRecord extends AttachedBucket { remoteIdentity: string; state: "active" | "detaching" }
type Records = { connection: ConnectionRecord; bucket: BucketRecord; key: KeyRecord; multipart: StorageMultipart }
type Kind = keyof Records
const actionSet = new Set<StorageAction>(storageActions)
const capabilityStatuses = new Set(["unknown", "supported", "unsupported", "failed"])
function read<K extends Kind>(kind: K, id: string): Records[K] | undefined {
  const row = getDatabase().query<{ data: string }, [string, string]>("SELECT data FROM storage_records WHERE kind=? AND id=?").get(kind, id)
  return row ? JSON.parse(row.data) as Records[K] : undefined
}
function list<K extends Kind>(kind: K, workspaceId?: string): Records[K][] {
  const database = getDatabase()
  const rows = workspaceId === undefined ? database.query<{ data: string }, [string]>("SELECT data FROM storage_records WHERE kind=? ORDER BY id").all(kind) : database.query<{ data: string }, [string, string]>("SELECT data FROM storage_records WHERE kind=? AND workspace_id=? ORDER BY id").all(kind, workspaceId)
  return rows.map(row => JSON.parse(row.data) as Records[K])
}
function put<K extends Kind>(kind: K, value: Records[K]) {
  getDatabase().run("INSERT INTO storage_records(kind,id,workspace_id,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data", [kind, value.id, value.workspaceId, JSON.stringify(value)])
}
function remove(kind: Kind, id: string) { getDatabase().run("DELETE FROM storage_records WHERE kind=? AND id=?", [kind, id]) }
function audit(workspaceId: string, resource: AuditResource, action: AuditAction = "config.update", result: "success" | "started" | "failure" = "success") { appendAuditSqlite(getDatabase(), { workspaceId, resource, action, result }) }
function scoped<K extends Kind>(kind: K, id: string, workspaceId: string): Records[K] {
  const value = read(kind, id)
  if (!value || value.workspaceId !== workspaceId) throw new Error("Storage resource not found.")
  return value
}
function ready() { if (!storageEnabled()) throw new Error("Storage is not enabled."); storageEncryptionKey() }
const name = (input: unknown) => { if (typeof input !== "string" || !input.trim() || input.length > 80) throw new Error("A name of 1–80 characters is required."); return input.trim() }
const publicConnection = (value: ConnectionRecord): StorageConnection => ({ id: value.id, workspaceId: value.workspaceId, name: value.name, endpoint: value.endpoint, region: value.region, revision: value.revision, forcePathStyle: value.forcePathStyle, capabilities: value.capabilities, options: value.options })
const publicKey = (value: KeyRecord): StorageClientKey => ({ id: value.id, workspaceId: value.workspaceId, name: value.name, accessKeyId: value.accessKeyId, policy: value.policy, revokedAt: value.revokedAt })
const publicBucket = (value: BucketRecord): AttachedBucket => ({ id: value.id, workspaceId: value.workspaceId, connectionId: value.connectionId, name: value.name, upstreamBucket: value.upstreamBucket, state: value.state, createdAt: value.createdAt })

export const storageDocumentIntegration: DocumentIntegration = {
  initialize(database, initial) { if (storageEnabled()) { storageEncryptionKey(); assertStorageSchema(database, initial) } },
  validateCollection() {}, tracks: () => false, changed() {}, async deletingTree() {},
}

export async function storageDashboard(): Promise<StorageDashboard> {
  if (!storageEnabled()) return { enabled: false, connections: [], buckets: [], keys: [], multiparts: [] }
  ready()
  const workspaceId = currentWorkspaceId()
  return withTransaction(async () => ({ enabled: true, connections: list("connection", workspaceId).map(publicConnection), buckets: list("bucket", workspaceId).map(publicBucket), keys: list("key", workspaceId).map(publicKey), multiparts: list("multipart", workspaceId) }))
}

export async function saveStorageConnection(input: { id?: string; name: string; endpoint: string; region: string; accessKeyId: string; secretAccessKey: string }) {
  ready()
  const workspaceId = currentWorkspaceId()
  const resolved = await resolveStorageEndpoint(input.endpoint, undefined, storageTrustedOrigins())
  if (!/^[a-z0-9-]{1,64}$/.test(input.region) || !input.accessKeyId || input.accessKeyId.length > 256 || !input.secretAccessKey || input.secretAccessKey.length > 4096) throw new Error("Invalid region or credentials.")
  const displayName = name(input.name)
  return withTransaction(async () => {
    const previous = input.id ? scoped("connection", input.id, workspaceId) : undefined
    if (previous && list("multipart", workspaceId).some(value => value.connectionId === previous.id)) throw new Error("Finish multipart cleanup before editing this connection.")
    if (previous && list("bucket", workspaceId).some(value => value.connectionId === previous.id) && (previous.endpoint !== resolved.url.origin || previous.region !== input.region)) throw new Error("Detach buckets before changing the endpoint or region.")
    const id = previous?.id || randomUUID()
    const value: ConnectionRecord = { id, workspaceId, name: displayName, revision: (previous?.revision || 0) + 1, endpoint: resolved.url.origin, region: input.region, forcePathStyle: true, capabilities: {}, credentials: encryptStorageSecret(JSON.stringify({ accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey }), storageEncryptionKey(), `${workspaceId}:connection:${id}`) }
    put("connection", value); audit(workspaceId, "storage-connection")
    return publicConnection(value)
  })
}
export async function setStorageCapabilities(id: string, revision: number, statuses: Partial<Record<StorageAction, CapabilityStatus>>, rangeStatus?: CapabilityStatus, exactKeysStatus?: CapabilityStatus) {
  ready(); const workspaceId = currentWorkspaceId()
  return withTransaction(async () => {
    const value = scoped("connection", id, workspaceId)
    if (revision !== value.revision) throw new Error("Connection revision changed; reload before declaring capabilities.")
    if (list("multipart", workspaceId).some(entry => entry.connectionId === id)) throw new Error("Finish multipart cleanup before changing capabilities.")
    for (const [action, status] of Object.entries(statuses)) {
      if (!actionSet.has(action as StorageAction) || !capabilityStatuses.has(status)) throw new Error("Invalid capability evidence.")
      value.capabilities[action as StorageAction] = { status, connectionRevision: revision, checkedAt: new Date().toISOString(), source: "administrator" }
    }
    for (const [option, status] of Object.entries({ ranges: rangeStatus, exactKeys: exactKeysStatus })) {
      if (status === undefined) continue
      if (!capabilityStatuses.has(status)) throw new Error("Invalid option capability.")
      value.options ||= {}
      value.options[option as "ranges" | "exactKeys"] = { status, connectionRevision: revision, checkedAt: new Date().toISOString(), source: "administrator" }
    }
    put("connection", value); audit(workspaceId, "storage-connection"); return publicConnection(value)
  })
}
export async function recordStorageProbe(id: string, revision: number, statuses: Partial<Record<StorageAction, CapabilityStatus>>) {
  const workspaceId = currentWorkspaceId()
  await withTransaction(async () => {
    const value = scoped("connection", id, workspaceId)
    if (value.revision !== revision) throw new Error("Connection changed during probe.")
    for (const [action, status] of Object.entries(statuses)) value.capabilities[action as StorageAction] = { status, connectionRevision: revision, checkedAt: new Date().toISOString(), source: "probe" }
    put("connection", value); audit(workspaceId, "storage-connection")
  })
}
export async function attachStorageBucket(input: { connectionId: string; name: string; upstreamBucket: string }) {
  ready(); const workspaceId = currentWorkspaceId()
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.name) || input.name.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(input.name) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.upstreamBucket)) throw new Error("Invalid bucket name.")
  return withTransaction(async () => {
    const connection = scoped("connection", input.connectionId, workspaceId)
    const remoteIdentity = `${connection.endpoint}/${input.upstreamBucket}`
    if (list("bucket").some(bucket => bucket.name === input.name || bucket.remoteIdentity === remoteIdentity)) throw new Error("Logical or upstream bucket is already attached.")
    const value: BucketRecord = { id: randomUUID(), workspaceId, connectionId: connection.id, name: input.name, upstreamBucket: input.upstreamBucket, remoteIdentity, state: "active", createdAt: new Date().toISOString() }
    put("bucket", value); audit(workspaceId, "storage-bucket"); return publicBucket(value)
  })
}
export async function createStorageKey(input: { name: string; bucketIds: string[]; actions: StorageAction[] }) {
  ready(); const workspaceId = currentWorkspaceId(); const displayName = name(input.name)
  return withTransaction(async () => {
    if (!Array.isArray(input.bucketIds) || !Array.isArray(input.actions) || !input.bucketIds.length || !input.actions.length || input.bucketIds.length > 100 || input.actions.some(action => !actionSet.has(action))) throw new Error("Select buckets and supported actions.")
    for (const id of input.bucketIds) if (scoped("bucket", id, workspaceId).state !== "active") throw new Error("Bucket is detaching.")
    const id = randomUUID(); const secretAccessKey = randomBytes(32).toString("base64url")
    const value: KeyRecord = { id, workspaceId, name: displayName, accessKeyId: `RR${randomBytes(14).toString("hex").toUpperCase()}`, policy: { bucketIds: [...new Set(input.bucketIds)], actions: [...new Set(input.actions)] }, secret: encryptStorageSecret(secretAccessKey, storageEncryptionKey(), `${workspaceId}:key:${id}`) }
    put("key", value); audit(workspaceId, "storage-key", "credential.create")
    return { key: publicKey(value), secretAccessKey }
  })
}
export async function revokeStorageKey(id: string) {
  ready(); const workspaceId = currentWorkspaceId()
  await withTransaction(async () => { const value = scoped("key", id, workspaceId); value.revokedAt ||= new Date().toISOString(); put("key", value); audit(workspaceId, "storage-key", "credential.revoke") })
}
export async function updateStorageKeyPolicy(id: string, input: { bucketIds: string[]; actions: StorageAction[] }) {
  ready(); const workspaceId = currentWorkspaceId()
  await withTransaction(async () => {
    const value = scoped("key", id, workspaceId)
    if (value.revokedAt || !Array.isArray(input.bucketIds) || !Array.isArray(input.actions) || input.bucketIds.length > 100 || input.actions.some(action => !actionSet.has(action))) throw new Error("Invalid key policy.")
    for (const bucketId of input.bucketIds) if (scoped("bucket", bucketId, workspaceId).state !== "active") throw new Error("Bucket is detaching.")
    value.policy = { bucketIds: [...new Set(input.bucketIds)], actions: [...new Set(input.actions)] }
    put("key", value); audit(workspaceId, "storage-key", "credential.update")
  })
}
export async function validateStorageEncryption() {
  await withTransaction(async () => {
    for (const connection of list("connection")) connectionCredentials(connection)
    for (const key of list("key")) decryptStorageSecret(key.secret, storageEncryptionKey(), `${key.workspaceId}:key:${key.id}`)
  })
}
export async function hasStorageWorkspaceRecords(workspaceId: string) {
  return withTransaction(async () => {
    if (!getDatabase().query("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_records'").get()) return false
    return Boolean(getDatabase().query("SELECT id FROM storage_records WHERE workspace_id=? LIMIT 1").get(workspaceId))
  })
}
export async function revealStorageKey(id: string) {
  ready(); const workspaceId = currentWorkspaceId()
  return withTransaction(async () => { const value = scoped("key", id, workspaceId); if (value.revokedAt) throw new Error("Key is revoked."); audit(workspaceId, "storage-key", "storage.secret.reveal"); return { accessKeyId: value.accessKeyId, secretAccessKey: decryptStorageSecret(value.secret, storageEncryptionKey(), `${workspaceId}:key:${id}`) } })
}
export async function lookupStorageCredential(accessKeyId: string) {
  if (!storageEnabled()) return undefined
  return withTransaction(async () => {
    const row = getDatabase().query<{ data: string }, [string]>("SELECT data FROM storage_records WHERE kind='key' AND json_extract(data,'$.accessKeyId')=?").get(accessKeyId)
    if (!row) return undefined
    const key = JSON.parse(row.data) as KeyRecord
    if (key.revokedAt) return undefined
    return { accessKeyId, secretAccessKey: decryptStorageSecret(key.secret, storageEncryptionKey(), `${key.workspaceId}:key:${key.id}`), workspaceId: key.workspaceId, keyId: key.id, revoked: false }
  })
}
export function connectionCredentials(connection: ConnectionRecord): { accessKeyId: string; secretAccessKey: string } { return JSON.parse(decryptStorageSecret(connection.credentials, storageEncryptionKey(), `${connection.workspaceId}:connection:${connection.id}`)) as { accessKeyId: string; secretAccessKey: string } }
export async function authorizeStorage(keyId: string, bucketName: string, action: StorageAction) {
  const workspaceId = currentWorkspaceId()
  return withTransaction(async () => {
    const key = scoped("key", keyId, workspaceId)
    if (key.revokedAt || !key.policy.actions.includes(action)) throw new Error("AccessDenied")
    const buckets = list("bucket", workspaceId).filter(bucket => bucket.state === "active" && storageKeyAllows(key, bucket, action))
    if (action === "ListBuckets") return { buckets, key }
    const bucket = buckets.find(value => value.name === bucketName)
    if (!bucket) throw new Error("AccessDenied")
    const connection = scoped("connection", bucket.connectionId, workspaceId)
    if (!supportsStorageAction(connection, action)) throw new Error("NotImplemented")
    if (action === "CreateMultipartUpload" && storageActions.filter(value => ["CreateMultipartUpload", "UploadPart", "ListParts", "CompleteMultipartUpload", "AbortMultipartUpload"].includes(value)).some(value => !supportsStorageAction(connection, value))) throw new Error("NotImplemented")
    return { buckets, bucket, connection, key }
  })
}
export async function storageRemoteAudit(resource: "storage-object" | "storage-multipart", result: "started" | "success" | "failure", workspaceId = currentWorkspaceId()) { await withTransaction(async () => { audit(workspaceId, resource, "storage.remote", result) }) }
export async function beginMultipart(bucket: AttachedBucket, keyId: string, key: string, snapshot: StorageConnection, id = randomUUID()) {
  const workspaceId = currentWorkspaceId()
  return withTransaction(async () => {
    const currentBucket = scoped("bucket", bucket.id, workspaceId)
    const credential = scoped("key", keyId, workspaceId)
    if (currentBucket.state !== "active" || currentBucket.connectionId !== bucket.connectionId || currentBucket.upstreamBucket !== bucket.upstreamBucket || currentBucket.name !== bucket.name || !storageKeyAllows(credential, currentBucket, "CreateMultipartUpload")) throw new Error("AccessDenied")
    const connection = scoped("connection", currentBucket.connectionId, workspaceId)
    // DNS/client construction runs before this transaction. Pin the authorization
    // and recovery identity atomically with the intent, including evidence edits
    // (which do not increment the connection revision).
    if (connection.id !== snapshot.id || connection.revision !== snapshot.revision || JSON.stringify(connection.capabilities) !== JSON.stringify(snapshot.capabilities) || JSON.stringify(connection.options) !== JSON.stringify(snapshot.options)) throw new Error("AccessDenied")
    if (["CreateMultipartUpload", "UploadPart", "ListParts", "CompleteMultipartUpload", "AbortMultipartUpload"].some(action => !supportsStorageAction(connection, action as StorageAction))) throw new Error("NotImplemented")
    const count = getDatabase().query<{ count: number }, [string]>("SELECT count(*) AS count FROM storage_records WHERE kind='multipart' AND workspace_id=?").get(workspaceId)!.count
    if (count >= maximumMultipartUploads) throw new Error("Storage admission unavailable.")
    const value: StorageMultipart = { id, workspaceId, bucketId: currentBucket.id, connectionId: connection.id, keyId, key, state: "creating", createdAt: new Date().toISOString() }
    put("multipart", value); audit(workspaceId, "storage-multipart", "storage.remote", "started"); return value
  })
}
export async function updateMultipart(value: StorageMultipart, result: "started" | "success" | "failure" = "success") { await withTransaction(async () => { scoped("multipart", value.id, value.workspaceId); put("multipart", value); audit(value.workspaceId, "storage-multipart", "storage.remote", result) }) }
export async function finishMultipart(value: StorageMultipart) { await withTransaction(async () => { scoped("multipart", value.id, value.workspaceId); remove("multipart", value.id); audit(value.workspaceId, "storage-multipart", "storage.remote") }) }
export async function getMultipart(id: string, bucket: AttachedBucket, keyId: string, key: string) { return withTransaction(async () => { const value = read("multipart", id); if (!value || value.workspaceId !== currentWorkspaceId() || value.bucketId !== bucket.id || value.keyId !== keyId || value.key !== key || value.state !== "active" || !value.remoteId) throw new Error("NoSuchUpload"); return value }) }
export async function recoveryMultiparts(workspaceId?: string) { if (!storageEnabled()) return []; return withTransaction(async () => list("multipart", workspaceId)) }
export async function recoveryMultipart(id: string, workspaceId: string) { return withTransaction(async () => { const value = read("multipart", id); return value?.workspaceId === workspaceId ? value : undefined }) }
export async function listClientMultiparts(bucketId: string, keyId: string) { return withTransaction(async () => list("multipart", currentWorkspaceId()).filter(value => value.bucketId === bucketId && value.keyId === keyId && value.state === "active")) }
export async function recoveryConnection(id: string, workspaceId: string) { return withTransaction(async () => scoped("connection", id, workspaceId)) }
export async function recoveryBucket(id: string, workspaceId: string) { return withTransaction(async () => scoped("bucket", id, workspaceId)) }
export async function markStorageBucketDetaching(id: string) { const workspaceId = currentWorkspaceId(); await withTransaction(async () => { const value = scoped("bucket", id, workspaceId); value.state = "detaching"; put("bucket", value); audit(workspaceId, "storage-bucket") }) }
export async function removeStorageBucket(id: string, workspaceId: string) { await withTransaction(async () => { if (list("multipart", workspaceId).some(value => value.bucketId === id)) throw new Error("Multipart cleanup is pending."); scoped("bucket", id, workspaceId); remove("bucket", id); audit(workspaceId, "storage-bucket", "config.delete") }) }
export async function deleteStorageConnection(id: string) { const workspaceId = currentWorkspaceId(); await withTransaction(async () => { scoped("connection", id, workspaceId); if (list("bucket", workspaceId).some(value => value.connectionId === id)) throw new Error("Detach buckets first."); remove("connection", id); audit(workspaceId, "storage-connection", "config.delete") }) }
export async function revokeStorageWorkspace(workspaceId: string) { if (!storageEnabled()) return; await withTransaction(async () => { for (const key of list("key", workspaceId)) { key.revokedAt ||= new Date().toISOString(); put("key", key) } for (const bucket of list("bucket", workspaceId)) { bucket.state = "detaching"; put("bucket", bucket) } audit(workspaceId, "storage-key", "credential.revoke") }) }
export async function removeStorageWorkspace(workspaceId: string) { if (!storageEnabled()) return; await withTransaction(async () => { if (list("multipart", workspaceId).length) throw new Error("Multipart cleanup is pending."); getDatabase().run("DELETE FROM storage_records WHERE workspace_id=?", [workspaceId]); audit(workspaceId, "storage-bucket", "config.delete") }) }
