import { afterAll, beforeEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { S3Client, CreateMultipartUploadCommand } from "@aws-sdk/client-s3"
import "../../apps/console/src/server/composition"
import { createWorkspace } from "../../packages/platform/src/server/runtime"
import { runInWorkspace } from "../../packages/platform/src/server/workspace-context"
import { ensureLocalDatabase, closeLocalDatabase, withTransaction } from "../../packages/platform/src/server/database"
import { storageActions } from "../../packages/gateway-storage/src/contracts"
import { saveStorageConnection, setStorageCapabilities, attachStorageBucket, createStorageKey, revokeStorageKey, updateStorageKeyPolicy, recoveryMultiparts, recoveryMultipart } from "../../packages/gateway-storage/src/server/repository"
import { cleanupStorageMultipart, resolveStorageMultipart } from "../../packages/gateway-storage/src/server/service"
import { startStorageListener } from "../../packages/gateway-storage/src/server/listener"
import type { StorageResolver } from "../../packages/gateway-storage/src/server/security"
import { storagePersistenceFixture } from "../fixtures/storage-persistence"

const persistence = storagePersistenceFixture()

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
beforeEach(async () => {
  persistence.configure()
  await ensureLocalDatabase()
})
afterAll(async () => { await closeLocalDatabase(); persistence.cleanup() })

async function fixture(resolver?: StorageResolver) {
  const createEntered = gate(), createReply = gate(), abortEntered = gate(), abortReply = gate()
  const remote = new Set<string>()
  let creates = 0, aborts = 0
  const provider = createServer((request, response) => { void (async () => {
    if (request.method === "POST") {
      creates++; remote.add("remote-owned-upload"); createEntered.release()
      await createReply.promise
      response.writeHead(200, { "content-type": "application/xml" })
      response.end("<InitiateMultipartUploadResult><UploadId>remote-owned-upload</UploadId></InitiateMultipartUploadResult>")
    } else if (request.method === "DELETE") {
      aborts++; abortEntered.release(); await abortReply.promise
      remote.delete("remote-owned-upload"); response.writeHead(204); response.end()
    } else { response.writeHead(501); response.end() }
  })().catch(() => response.destroy()) })
  await new Promise<void>(resolve => provider.listen(0, resolve))
  const address = provider.address()
  if (!address || typeof address === "string") throw new Error("Missing provider port")
  const endpoint = `http://localhost:${address.port}`
  process.env.STORAGE_S3_ALLOWED_ORIGINS = endpoint
  const workspace = await createWorkspace(`Multipart race ${crypto.randomUUID()}`)
  const scope = <T,>(callback: () => T) => runInWorkspace(workspace, callback)
  const input = { name: "Race provider", endpoint, region: "us-east-1", accessKeyId: "TEST-upstream-original", secretAccessKey: "TEST-upstream-original-secret" }
  const connection = await scope(() => saveStorageConnection(input))
  await scope(() => setStorageCapabilities(connection.id, connection.revision, Object.fromEntries(storageActions.map(action => [action, "supported"]))))
  const bucket = await scope(() => attachStorageBucket({ connectionId: connection.id, name: `race-${crypto.randomUUID()}`, upstreamBucket: "upstream-race-bucket" }))
  const issued = await scope(() => createStorageKey({ name: "Race client", bucketIds: [bucket.id], actions: [...storageActions] }))
  const listener = await startStorageListener({ hostname: "127.0.0.1", port: 0, region: "us-east-1", resolver })
  if (!listener.address || typeof listener.address === "string") throw new Error("Missing listener port")
  const client = new S3Client({ endpoint: `http://127.0.0.1:${listener.address.port}`, region: "us-east-1", forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", credentials: { accessKeyId: issued.key.accessKeyId, secretAccessKey: issued.secretAccessKey } })
  return {
    scope, input, connection, issued, workspace, createEntered, createReply, abortEntered, abortReply, remote,
    counts: () => ({ creates, aborts }),
    initiate: () => client.send(new CreateMultipartUploadCommand({ Bucket: bucket.name, Key: "race-key" })),
    async close() { createReply.release(); abortReply.release(); await listener.stop(); client.destroy(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())) },
  }
}

for (const mutation of ["credentials", "abort-capability", "revocation", "policy"] as const) {
  test(`multipart intent atomically rejects ${mutation} changed during paused upstream DNS`, async () => {
    const dnsEntered = gate(), dnsReply = gate()
    const context = await fixture(async () => { dnsEntered.release(); await dnsReply.promise; return [{ address: "127.0.0.1", family: 4 }] })
    const initiation = context.initiate().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    try {
      await dnsEntered.promise
      expect(await recoveryMultiparts(context.workspace.id)).toHaveLength(0)
      if (mutation === "credentials") await context.scope(() => saveStorageConnection({ ...context.input, id: context.connection.id, secretAccessKey: "TEST-replaced-secret" }))
      else if (mutation === "abort-capability") await context.scope(() => setStorageCapabilities(context.connection.id, context.connection.revision, { AbortMultipartUpload: "unsupported" }))
      else if (mutation === "revocation") await context.scope(() => revokeStorageKey(context.issued.key.id))
      else await context.scope(() => updateStorageKeyPolicy(context.issued.key.id, { bucketIds: [], actions: [] }))
      dnsReply.release()
      expect((await initiation).error).toMatchObject({ name: "AccessDenied" })
      expect(context.counts()).toEqual({ creates: 0, aborts: 0 })
      expect(await recoveryMultiparts(context.workspace.id)).toHaveLength(0)
    } finally { dnsReply.release(); await initiation; await context.close() }
  })
}

for (const first of ["cleanup", "absence-resolution"] as const) {
  test(`live initiation owns its serializer before intent visibility with ${first} queued first`, async () => {
    const context = await fixture()
    const initiation = context.initiate()
    try {
      await context.createEntered.promise
      const [intent] = await recoveryMultiparts(context.workspace.id)
      expect(intent).toMatchObject({ state: "creating" })
      expect(intent?.remoteId).toBeUndefined()
      let cleaned = false, resolved = false
      const cleanup = () => cleanupStorageMultipart(intent!).then(() => { cleaned = true })
      const resolve = () => context.scope(() => resolveStorageMultipart(intent!.id, { confirmedAbsent: true })).then(() => { resolved = true }, error => { resolved = true; return error })
      // These calls synchronously enqueue on the upload serializer. A DB queue
      // barrier proves unrelated transactions continue while initiation is held.
      const tasks = first === "cleanup" ? [cleanup(), resolve()] : [resolve(), cleanup()]
      await withTransaction(async () => undefined)
      expect(cleaned).toBe(false); expect(resolved).toBe(false)
      expect(await recoveryMultipart(intent!.id, context.workspace.id)).toMatchObject({ state: "creating" })
      expect(context.remote.size).toBe(1)
      await expect(context.scope(() => saveStorageConnection({ ...context.input, id: context.connection.id }))).rejects.toThrow("Finish multipart cleanup")
      await expect(context.scope(() => setStorageCapabilities(context.connection.id, context.connection.revision, { AbortMultipartUpload: "unsupported" }))).rejects.toThrow("Finish multipart cleanup")
      context.createReply.release()
      expect((await initiation).UploadId).toBe(intent!.id)
      await context.abortEntered.promise
      expect(await recoveryMultipart(intent!.id, context.workspace.id)).toMatchObject({ state: "aborting", remoteId: "remote-owned-upload" })
      expect(context.remote.size).toBe(1)
      context.abortReply.release()
      await Promise.all(tasks)
      expect(context.counts()).toEqual({ creates: 1, aborts: 1 })
      expect(context.remote.size).toBe(0)
      expect(await recoveryMultiparts(context.workspace.id)).toHaveLength(0)
    } finally { context.createReply.release(); context.abortReply.release(); await initiation.catch(() => undefined); await context.close() }
  })
}
