/** Closed protocol surface. Capabilities not listed here are not implemented. */
export const storageActions = ["ListBuckets", "HeadBucket", "GetBucketLocation", "ListObjectsV2", "PutObject", "GetObject", "HeadObject", "DeleteObject", "CreateMultipartUpload", "UploadPart", "ListParts", "ListMultipartUploads", "CompleteMultipartUpload", "AbortMultipartUpload"] as const
export type StorageAction = typeof storageActions[number]
export type CapabilityStatus = "unknown" | "supported" | "unsupported" | "failed"
export interface CapabilityEvidence {
  status: CapabilityStatus
  /** Changes to endpoint, credentials, region or options invalidate evidence. */
  connectionRevision: number
  checkedAt: string
  source: "probe" | "administrator"
}
export interface StorageConnection {
  name?: string
  id: string
  workspaceId: string
  revision: number
  endpoint: string
  region: string
  forcePathStyle: boolean
  capabilities: Partial<Record<StorageAction, CapabilityEvidence>>
  options?: { ranges?: CapabilityEvidence; exactKeys?: CapabilityEvidence }
}
export interface AttachedBucket {
  createdAt?: string
  state?: "active" | "detaching"
  id: string
  workspaceId: string
  connectionId: string
  /** Globally unique gateway name, never used as the upstream bucket name. */
  name: string
  upstreamBucket: string
}
export interface StorageKeyPolicy {
  bucketIds: readonly string[]
  actions: readonly StorageAction[]
}
export interface StorageClientKey {
  name?: string
  id: string
  workspaceId: string
  accessKeyId: string
  revokedAt?: string
  policy: StorageKeyPolicy
}

export interface StorageMultipart {
  id: string
  workspaceId: string
  bucketId: string
  connectionId: string
  keyId: string
  key: string
  remoteId?: string
  state: "creating" | "active" | "completing" | "aborting" | "ambiguous"
  createdAt: string
}
export interface StorageDashboard {
  enabled: boolean
  connections: StorageConnection[]
  buckets: AttachedBucket[]
  keys: StorageClientKey[]
  multiparts: StorageMultipart[]
}

/** Unknown, failed and stale evidence must never turn into optimistic support. */
export function supportsStorageAction(connection: StorageConnection, action: StorageAction): boolean {
  const evidence = connection.capabilities[action]
  return evidence?.status === "supported" && evidence.connectionRevision === connection.revision
}

export function storageKeyAllows(key: StorageClientKey, bucket: AttachedBucket, action: StorageAction): boolean {
  return !key.revokedAt && key.workspaceId === bucket.workspaceId && key.policy.bucketIds.includes(bucket.id) && key.policy.actions.includes(action)
}
