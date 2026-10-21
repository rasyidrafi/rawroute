import { currentWorkspaceId } from "@rawroute/platform/server/workspace-context"
import { mapConcurrent } from "@rawroute/platform/server/concurrency"
import { type StorageMultipart, type CapabilityStatus, type StorageAction } from "../contracts"
import { createStorageUpstream, StorageUpstreamError } from "./upstream"
import { connectionCredentials, finishMultipart, markStorageBucketDetaching, recoveryBucket, recoveryConnection, recoveryMultiparts, removeStorageBucket, removeStorageWorkspace, revokeStorageWorkspace, updateMultipart, storageRemoteAudit, recordStorageProbe } from "./repository"
import { hasStorageWorkspaceRecords, recoveryMultipart } from "./repository"
import { storageEnabled } from "./config"

const bucketCounts = new Map<string, number>()
const closedBuckets = new Set<string>()
const bucketWaiters = new Map<string, Set<() => void>>()
export function admitStorageBucket(id: string) {
  if (closedBuckets.has(id)) throw new Error("AccessDenied")
  bucketCounts.set(id, (bucketCounts.get(id) || 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = bucketCounts.get(id)! - 1
    if (remaining) bucketCounts.set(id, remaining)
    else { bucketCounts.delete(id); for (const resolve of bucketWaiters.get(id) || []) resolve(); bucketWaiters.delete(id) }
  }
}
async function drainBucket(id: string) {
  if (!bucketCounts.has(id)) return
  await new Promise<void>(resolve => { const waiters = bucketWaiters.get(id) || new Set<() => void>(); waiters.add(resolve); bucketWaiters.set(id, waiters) })
}
const multipartTails = new Map<string, Promise<void>>()
export async function serializeMultipart<T>(id: string, callback: () => Promise<T>): Promise<T> {
  const before = multipartTails.get(id) || Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>(resolve => { release = resolve })
  multipartTails.set(id, tail)
  await before
  try { return await callback() } finally { release(); if (multipartTails.get(id) === tail) multipartTails.delete(id) }
}
export async function cleanupStorageMultipart(value: StorageMultipart) {
  await serializeMultipart(value.id, () => cleanupMultipartUnlocked(value))
}
async function cleanupMultipartUnlocked(snapshot: StorageMultipart) {
    const value = await recoveryMultipart(snapshot.id, snapshot.workspaceId)
    if (!value) return
    if (!value.remoteId) {
      await updateMultipart({ ...value, state: "ambiguous" }, "failure")
      throw new Error("Multipart initiation outcome is ambiguous; resolve it in Storage management.")
    }
    const [connection, bucket] = await Promise.all([recoveryConnection(value.connectionId, value.workspaceId), recoveryBucket(value.bucketId, value.workspaceId)])
    const upstream = await createStorageUpstream({ connection, upstreamBucket: bucket.upstreamBucket, credentials: connectionCredentials(connection) })
    try {
      await updateMultipart({ ...value, state: "aborting" }, "started")
      try { await upstream.abortMultipart({ Key: value.key, UploadId: value.remoteId }) } catch (error) { if (!(error instanceof StorageUpstreamError && error.code === "NoSuchUpload")) throw error }
      await finishMultipart(value)
    } catch (error) { await storageRemoteAudit("storage-multipart", "failure", value.workspaceId); throw error } finally { upstream.close() }
}
/** Preserve retry ownership on every failure. No attached object is deleted. */
export async function cleanupStorageWorkspace(workspaceId: string) {
  if (!storageEnabled()) { if (await hasStorageWorkspaceRecords(workspaceId)) throw new Error("Re-enable Storage to clean up this workspace; persisted Storage ownership cannot be abandoned."); return }
  await revokeStorageWorkspace(workspaceId)
  await mapConcurrent(await recoveryMultiparts(workspaceId), 1, cleanupStorageMultipart)
  await removeStorageWorkspace(workspaceId)
}
export async function detachStorageBucket(id: string) {
  const workspaceId = currentWorkspaceId()
  closedBuckets.add(id)
  try { await markStorageBucketDetaching(id) } catch (error) { closedBuckets.delete(id); throw error }
  await drainBucket(id)
  await mapConcurrent((await recoveryMultiparts(workspaceId)).filter(value => value.bucketId === id), 1, cleanupStorageMultipart)
  await removeStorageBucket(id, workspaceId)
  closedBuckets.delete(id)
}
export async function recoverStorageMultiparts() {
  let pending = 0
  await mapConcurrent(await recoveryMultiparts(), 1, async value => {
    try { await cleanupStorageMultipart(value) } catch { pending++ }
  })
  return pending
}
export async function resolveStorageMultipart(id: string, input: { remoteId?: string; confirmedAbsent?: boolean }) {
  return serializeMultipart(id, () => resolveMultipartUnlocked(id, input))
}
async function resolveMultipartUnlocked(id: string, input: { remoteId?: string; confirmedAbsent?: boolean }) {
  const workspaceId = currentWorkspaceId()
  const value = (await recoveryMultiparts(workspaceId)).find(entry => entry.id === id)
  if (!value) throw new Error("Multipart not found.")
  if (input.confirmedAbsent && input.remoteId) throw new Error("Invalid conflicting recovery resolution.")
  if (input.confirmedAbsent === true && value.state === "ambiguous" && !value.remoteId) { await finishMultipart(value); return }
  if (input.remoteId) {
    if (value.remoteId || value.state !== "ambiguous" || input.remoteId.length > 4096) throw new Error("Invalid recovery mapping.")
    const [connection, bucket] = await Promise.all([recoveryConnection(value.connectionId, workspaceId), recoveryBucket(value.bucketId, workspaceId)])
    const upstream = await createStorageUpstream({ connection, upstreamBucket: bucket.upstreamBucket, credentials: connectionCredentials(connection) })
    try { await upstream.listParts({ Key: value.key, UploadId: input.remoteId, MaxParts: 1 }) } catch { throw new Error("Multipart upload ID could not be verified against this bucket and object key.") } finally { upstream.close() }
    value.remoteId = input.remoteId
    await updateMultipart(value)
  }
  await cleanupMultipartUnlocked(value)
}
export async function probeStorageBucket(id: string) {
  const workspaceId = currentWorkspaceId()
  const bucket = await recoveryBucket(id, workspaceId)
  const connection = await recoveryConnection(bucket.connectionId, workspaceId)
  const upstream = await createStorageUpstream({ connection, upstreamBucket: bucket.upstreamBucket, credentials: connectionCredentials(connection), probe: true })
  const statuses: Partial<Record<StorageAction, CapabilityStatus>> = {}
  try {
    await Promise.all((["HeadBucket", "GetBucketLocation", "ListObjectsV2"] as const).map(async action => {
      try {
        if (action === "HeadBucket") await upstream.headBucket()
        else if (action === "GetBucketLocation") await upstream.getBucketLocation()
        else await upstream.listObjects({ MaxKeys: 1 })
        statuses[action] = "supported"
      } catch { statuses[action] = "failed" }
    }))
    await recordStorageProbe(connection.id, connection.revision, statuses)
    return statuses
  } finally { upstream.close() }
}
