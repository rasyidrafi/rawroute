import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { Readable } from "node:stream"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { S3Client, CreateBucketCommand, DeleteBucketCommand, ListBucketsCommand, HeadBucketCommand, GetBucketLocationCommand, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand, ListMultipartUploadsCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { Sha256 } from "@aws-crypto/sha256-js"
import { SignatureV4 } from "@smithy/signature-v4"
import { HttpRequest } from "@smithy/protocol-http"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { connect } from "node:net"
import "../../apps/console/src/server/composition"
import { createWorkspace, getWorkspace, deleteWorkspace } from "../../packages/platform/src/server/runtime"
import { runInWorkspace } from "../../packages/platform/src/server/workspace-context"
import { ensureLocalDatabase, closeLocalDatabase, getDatabase, withTransaction } from "../../packages/platform/src/server/database"
import { storageActions, type AttachedBucket, type StorageConnection } from "../../packages/gateway-storage/src/contracts"
import { saveStorageConnection, setStorageCapabilities, attachStorageBucket, createStorageKey, revokeStorageKey, storageDashboard, revealStorageKey, beginMultipart, recoveryMultiparts, recoveryConnection, updateStorageKeyPolicy, validateStorageEncryption, deleteStorageConnection } from "../../packages/gateway-storage/src/server/repository"
import { startStorageListener } from "../../packages/gateway-storage/src/server/listener"
import { recoverStorageMultiparts, resolveStorageMultipart, detachStorageBucket, cleanupStorageWorkspace } from "../../packages/gateway-storage/src/server/service"
import type { Workspace } from "../../packages/platform/src/contracts/workspace"
import { storagePersistenceFixture } from "../fixtures/storage-persistence"
import { storageKeyPath } from "../../packages/gateway-storage/src/server/config"

const persistence = storagePersistenceFixture()

const provider = process.env.STORAGE_TEST_S3_URL
const suffix = crypto.randomUUID().slice(0, 8)
const upstreamBuckets = [`rr-native-a-${suffix}`, `rr-native-b-${suffix}`]
const upstreamCredentials = { accessKeyId: "disposable-upstream", secretAccessKey: "disposable-upstream-secret" }
let workspaceA: Workspace, workspaceB: Workspace
let connectionA: StorageConnection, bucketA: AttachedBucket, bucketB: AttachedBucket
let issued: Awaited<ReturnType<typeof createStorageKey>>
let listener: Awaited<ReturnType<typeof startStorageListener>>
let client: S3Client, admin: S3Client
let endpoint: string
const key = "folder/plus+percent% space/日本語"
const scopeA = <T,>(callback: () => T) => runInWorkspace(workspaceA, callback)
const integration = provider ? test : test.skip
function rawExchange(method: string, target: string, headers: string[]) {
  const address = new URL(endpoint)
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = connect({ host: address.hostname, port: Number(address.port) }, () => socket.write(`${method} ${target} HTTP/1.1\r\n${headers.join("\r\n")}\r\nConnection: close\r\n\r\n`))
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("Storage raw HTTP test timed out")) })
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)))
    socket.on("error", reject)
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}

function configureEnvironment() {
  persistence.configure()
  process.env.STORAGE_S3_ALLOWED_ORIGINS = provider || "http://127.0.0.1:19090"
}
beforeEach(configureEnvironment)
beforeAll(async () => {
  configureEnvironment()
  await ensureLocalDatabase()
  workspaceA = await createWorkspace(`Storage A ${suffix}`)
  workspaceB = await createWorkspace(`Storage B ${suffix}`)
  connectionA = await scopeA(() => saveStorageConnection({ name: "Native S3", endpoint: provider || "http://127.0.0.1:19090", region: "us-east-1", ...upstreamCredentials }))
  bucketA = await scopeA(() => attachStorageBucket({ connectionId: connectionA.id, name: `logical-a-${suffix}`, upstreamBucket: upstreamBuckets[0]! }))
  const connectionB = await runInWorkspace(workspaceB, () => saveStorageConnection({ name: "Separate owner", endpoint: provider || "http://127.0.0.1:19090", region: "us-east-1", ...upstreamCredentials }))
  bucketB = await runInWorkspace(workspaceB, () => attachStorageBucket({ connectionId: connectionB.id, name: `logical-b-${suffix}`, upstreamBucket: upstreamBuckets[1]! }))
  issued = await scopeA(() => createStorageKey({ name: "Client A", bucketIds: [bucketA.id], actions: [...storageActions] }))
  listener = await startStorageListener({ hostname: "127.0.0.1", port: 0, region: "us-east-1" })
  if (!listener.address || typeof listener.address === "string") throw new Error("Invalid test listener address")
  endpoint = `http://127.0.0.1:${listener.address.port}`
  client = new S3Client({ endpoint, region: "us-east-1", credentials: { accessKeyId: issued.key.accessKeyId, secretAccessKey: issued.secretAccessKey }, forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" })
  if (provider) {
    admin = new S3Client({ endpoint: provider, region: "us-east-1", credentials: upstreamCredentials, forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED" })
    for (const Bucket of upstreamBuckets) await admin.send(new CreateBucketCommand({ Bucket }))
  }
})
afterAll(async () => {
  await listener?.stop()
  client?.destroy()
  if (admin) {
    for (const Bucket of upstreamBuckets) {
      const result = await admin.send(new ListObjectsV2Command({ Bucket }))
      for (const object of result.Contents || []) await admin.send(new DeleteObjectCommand({ Bucket, Key: object.Key }))
      await admin.send(new DeleteBucketCommand({ Bucket }))
    }
    admin.destroy()
  }
  await closeLocalDatabase()
  persistence.cleanup()
})

test("audited Storage repository requires workspace, encrypts secrets, enforces owner and unique attachment", async () => {
  await expect(storageDashboard()).rejects.toThrow("Workspace scope")
  const dashboard = await scopeA(storageDashboard)
  expect(dashboard.connections).toHaveLength(1)
  expect(dashboard.keys[0]!.accessKeyId).toBe(issued.key.accessKeyId)
  expect(JSON.stringify(dashboard)).not.toContain(issued.secretAccessKey)
  const persisted = JSON.stringify(getDatabase().query("SELECT data FROM storage_records").all())
  expect(persisted).not.toContain(issued.secretAccessKey)
  expect(persisted).not.toContain(upstreamCredentials.secretAccessKey)
  expect(await scopeA(() => revealStorageKey(issued.key.id))).toEqual({ accessKeyId: issued.key.accessKeyId, secretAccessKey: issued.secretAccessKey })
  await expect(runInWorkspace(workspaceB, () => revealStorageKey(issued.key.id))).rejects.toThrow("not found")
  await expect(runInWorkspace(workspaceB, () => attachStorageBucket({ connectionId: connectionA.id, name: "cannot-cross-owner", upstreamBucket: "other-bucket" }))).rejects.toThrow("not found")
  await expect(scopeA(() => attachStorageBucket({ connectionId: connectionA.id, name: `another-${suffix}`, upstreamBucket: upstreamBuckets[0]! }))).rejects.toThrow("already attached")
  expect(getDatabase().query("SELECT data FROM rawroute_documents WHERE json_extract(data,'$.resource')='storage-key'").all().length).toBeGreaterThan(0)
})

test("actual S3 listener filters ListBuckets and rejects unknown capabilities/cross-workspace access", async () => {
  expect((await client.send(new ListBucketsCommand({}))).Buckets?.map(value => value.Name)).toEqual([bucketA.name])
  await expect(client.send(new HeadBucketCommand({ Bucket: bucketA.name }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 501 } })
  await expect(client.send(new GetObjectCommand({ Bucket: bucketB.name, Key: "private" }))).rejects.toMatchObject({ name: "AccessDenied" })
  await scopeA(() => setStorageCapabilities(connectionA.id, connectionA.revision, Object.fromEntries(storageActions.map(action => [action, "supported"])), "supported", "supported"))
})

test("audit failure rolls back key creation and a wrong encryption key fails closed", async () => {
  const before = (await scopeA(storageDashboard)).keys.length
  await withTransaction(async () => { getDatabase().run("CREATE TRIGGER storage_test_reject_audit BEFORE INSERT ON rawroute_documents WHEN json_extract(NEW.data,'$.resource')='storage-key' BEGIN SELECT RAISE(ABORT,'audit rejected'); END") })
  try { await expect(scopeA(() => createStorageKey({ name: "Must roll back", bucketIds: [bucketA.id], actions: ["GetObject"] }))).rejects.toThrow("audit rejected") } finally { await withTransaction(async () => { getDatabase().run("DROP TRIGGER storage_test_reject_audit") }) }
  expect((await scopeA(storageDashboard)).keys).toHaveLength(before)
  const original = readFileSync(storageKeyPath())
  writeFileSync(storageKeyPath(), "b".repeat(64))
  try { await expect(validateStorageEncryption()).rejects.toThrow("Storage secret could not be decrypted") }
  finally { writeFileSync(storageKeyPath(), original) }
  await validateStorageEncryption()
})

test("raw listener rejects ambiguous framing/targets with XML and ignores dashboard workspace selection", async () => {
  const host = new URL(endpoint).host
  for (const [target, headers] of [["/", [`Host: ${host}`, `Host: ${host}`]], ["/", [`Host: ${host}`, "Content-Length: 0", "Transfer-Encoding: chunked"]], ["http://other.example/bucket", [`Host: ${host}`]]] as const) {
    const result = await rawExchange("GET", target, [...headers])
    expect(result).toContain("400")
    expect(result).toContain("<Code>InvalidRequest</Code>")
  }
  const signer = new SignatureV4({ credentials: { accessKeyId: issued.key.accessKeyId, secretAccessKey: issued.secretAccessKey }, region: "us-east-1", service: "s3", sha256: Sha256, uriEscapePath: false })
  const signed = await signer.sign(new HttpRequest({ hostname: host, method: "GET", path: "/", headers: { host, "x-rawroute-workspace-id": workspaceB.id } }))
  const listing = await rawExchange("GET", "/", Object.entries(signed.headers).map(([name, value]) => `${name}: ${value}`))
  expect(listing).toContain(bucketA.name)
  expect(listing).not.toContain(bucketB.name)
  process.env.STORAGE_S3_MAX_BODY_BYTES = "999999999999"
  const oversized = await signer.sign(new HttpRequest({ hostname: host, method: "PUT", path: `/${bucketA.name}/too-large`, headers: { host, "content-length": String(5 * 1024 ** 3 + 1), expect: "100-continue" } }))
  const rejected = await rawExchange("PUT", oversized.path, Object.entries(oversized.headers).map(([name, value]) => `${name}: ${value}`))
  expect(rejected).toContain("413")
  expect(rejected).not.toContain("100 Continue")
})

test("policy updates apply immediately and disabling Storage cannot abandon deletion cleanup", async () => {
  await scopeA(() => updateStorageKeyPolicy(issued.key.id, { bucketIds: [], actions: [] }))
  await expect(client.send(new ListBucketsCommand({}))).rejects.toMatchObject({ name: "AccessDenied" })
  await scopeA(() => updateStorageKeyPolicy(issued.key.id, { bucketIds: [bucketA.id], actions: [...storageActions] }))
  process.env.STORAGE_ENABLED = "false"
  await expect(cleanupStorageWorkspace(workspaceB.id)).rejects.toThrow("Re-enable Storage")
})

integration("native SDK core, encoded keys, ranges, presigned GET/PUT and unsupported semantics", async () => {
  await client.send(new HeadBucketCommand({ Bucket: bucketA.name }))
  await client.send(new GetBucketLocationCommand({ Bucket: bucketA.name }))
  const saved = await client.send(new PutObjectCommand({ Bucket: bucketA.name, Key: key, Body: "hello-storage", ContentType: "text/plain" }))
  expect(getDatabase().query("SELECT data FROM rawroute_documents WHERE json_extract(data,'$.correlationId')=? AND json_extract(data,'$.actorId')=?").all(saved.$metadata.requestId!, issued.key.id)).toHaveLength(2)
  expect((await client.send(new HeadObjectCommand({ Bucket: bucketA.name, Key: key }))).ContentLength).toBe(13)
  expect(await (await client.send(new GetObjectCommand({ Bucket: bucketA.name, Key: key }))).Body?.transformToString()).toBe("hello-storage")
  expect(await (await client.send(new GetObjectCommand({ Bucket: bucketA.name, Key: key, Range: "bytes=1-4" }))).Body?.transformToString()).toBe("ello")
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucketA.name, Prefix: "folder/", MaxKeys: 1 }))
  expect(listed.Name).toBe(bucketA.name)
  expect(listed.Contents?.[0]?.Key).toBe(key)
  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucketA.name, Key: key }), { expiresIn: 60 })
  expect(await (await fetch(url)).text()).toBe("hello-storage")
  const putUrl = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucketA.name, Key: "presigned" }), { expiresIn: 60 })
  const put = await fetch(putUrl, { method: "PUT", body: "presigned-value" })
  expect(put.status).toBe(200)
  expect(await (await client.send(new GetObjectCommand({ Bucket: bucketA.name, Key: "presigned" }))).Body?.transformToString()).toBe("presigned-value")
  await expect(client.send(new PutObjectCommand({ Bucket: bucketA.name, Key: "unsupported-tags", Body: "no", Tagging: "a=b" }))).rejects.toMatchObject({ name: "NotImplemented" })
  await expect(client.send(new GetObjectCommand({ Bucket: bucketA.name, Key: key, VersionId: "old" }))).rejects.toMatchObject({ name: "NotImplemented" })
  await client.send(new DeleteObjectCommand({ Bucket: bucketA.name, Key: "presigned" }))
  for (const rawKey of ["a/../b//%2e/%2F", "literal%2F", "trailing/", "double//slash"]) {
    await client.send(new PutObjectCommand({ Bucket: bucketA.name, Key: rawKey, Body: "raw-key" }))
    expect(await (await client.send(new GetObjectCommand({ Bucket: bucketA.name, Key: rawKey }))).Body?.transformToString()).toBe("raw-key")
    expect(await (await admin.send(new GetObjectCommand({ Bucket: upstreamBuckets[0], Key: rawKey }))).Body?.transformToString()).toBe("raw-key")
    expect((await admin.send(new ListObjectsV2Command({ Bucket: upstreamBuckets[0] }))).Contents?.map(value => value.Key)).toContain(rawKey)
  }
})

integration("multipart mappings are durable/scoped and support list, completion, abort and restart cleanup", async () => {
  const started = await client.send(new CreateMultipartUploadCommand({ Bucket: bucketA.name, Key: "multipart" }))
  const UploadId = started.UploadId!
  expect(UploadId).toMatch(/^[a-f0-9-]{36}$/)
  expect((await recoveryMultiparts()).find(value => value.id === UploadId)?.remoteId).toBeTruthy()
  const part = await client.send(new UploadPartCommand({ Bucket: bucketA.name, Key: "multipart", UploadId, PartNumber: 1, Body: "multipart-body" }))
  expect((await client.send(new ListPartsCommand({ Bucket: bucketA.name, Key: "multipart", UploadId }))).Parts?.[0]?.PartNumber).toBe(1)
  await expect(client.send(new ListPartsCommand({ Bucket: bucketA.name, Key: "wrong-key", UploadId }))).rejects.toMatchObject({ name: "NoSuchUpload" })
  await client.send(new CompleteMultipartUploadCommand({ Bucket: bucketA.name, Key: "multipart", UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] } }))
  expect(await (await client.send(new GetObjectCommand({ Bucket: bucketA.name, Key: "multipart" }))).Body?.transformToString()).toBe("multipart-body")
  expect((await recoveryMultiparts()).some(value => value.id === UploadId)).toBe(false)
  const abandoned = await client.send(new CreateMultipartUploadCommand({ Bucket: bucketA.name, Key: "abandoned" }))
  await client.send(new AbortMultipartUploadCommand({ Bucket: bucketA.name, Key: "abandoned", UploadId: abandoned.UploadId }))
  await client.send(new CreateMultipartUploadCommand({ Bucket: bucketA.name, Key: "restart-cleanup" }))
  expect(await recoverStorageMultiparts()).toBe(0)
  expect(await recoveryMultiparts()).toHaveLength(0)
})

integration("network upload/download streams a generated 256 MiB object with bounded additional RSS", async () => {
  const size = 256 * 1024 * 1024
  const initialRss = process.memoryUsage().rss
  let peakRss = initialRss
  const body = Readable.from((async function* () { for (let sent = 0; sent < size; sent += 64 * 1024) { peakRss = Math.max(peakRss, process.memoryUsage().rss); yield new Uint8Array(64 * 1024) } })())
  await client.send(new PutObjectCommand({ Bucket: bucketA.name, Key: "large-stream", Body: body, ContentLength: size }))
  const result = await client.send(new GetObjectCommand({ Bucket: bucketA.name, Key: "large-stream" }))
  let received = 0
  for await (const chunk of result.Body!.transformToWebStream()) { received += chunk.byteLength; peakRss = Math.max(peakRss, process.memoryUsage().rss) }
  expect(received).toBe(size)
  expect(peakRss - initialRss).toBeLessThan(192 * 1024 * 1024)
  console.log(`Storage streamed 256 MiB; peak additional RSS ${Math.ceil((peakRss - initialRss) / 1024 / 1024)} MiB.`)
}, 120_000)

integration("signed body mismatch and declared body limits cannot overwrite upstream objects", async () => {
  await client.send(new PutObjectCommand({ Bucket: bucketA.name, Key: "protected", Body: "original" }))
  const target = new URL(endpoint)
  const signer = new SignatureV4({ credentials: { accessKeyId: issued.key.accessKeyId, secretAccessKey: issued.secretAccessKey }, region: "us-east-1", service: "s3", sha256: Sha256, uriEscapePath: false })
  const path = `/${bucketA.name}/protected`
  const headers = (await signer.sign(new HttpRequest({ hostname: target.hostname, method: "PUT", path, headers: { host: target.host, "content-length": "8", "x-amz-content-sha256": createHash("sha256").update("not-body").digest("hex") }, body: "bad-body" }))).headers
  const response = await fetch(`${endpoint}${path}`, { method: "PUT", headers, body: "bad-body" })
  expect(response.status).toBe(400)
  expect(await response.text()).toContain("XAmzContentSHA256Mismatch")
  expect(await (await admin.send(new GetObjectCommand({ Bucket: upstreamBuckets[0], Key: "protected" }))).Body?.transformToString()).toBe("original")
  const oversized = await signer.sign(new HttpRequest({ hostname: target.host, method: "PUT", path, headers: { host: target.host, "content-length": String(5 * 1024 ** 3 + 1), expect: "100-continue" } }))
  expect(await rawExchange("PUT", path, Object.entries(oversized.headers).map(([name, value]) => `${name}: ${value}`))).toContain("413")
  expect(await (await admin.send(new GetObjectCommand({ Bucket: upstreamBuckets[0], Key: "protected" }))).Body?.transformToString()).toBe("original")
})

integration("lost remote initiation and abort faults retain recovery mappings until explicit successful cleanup", async () => {
  const Bucket = `fault-owned-${suffix}`
  await admin.send(new CreateBucketCommand({ Bucket }))
  let remoteId: string | undefined
  let creates = 0, aborts = 0
  const server = createServer((request, response) => { void (async () => {
    if (request.method === "POST") {
      creates++
      remoteId = (await admin.send(new CreateMultipartUploadCommand({ Bucket, Key: "ambiguous-remote" }))).UploadId
      request.socket.destroy()
    } else if (request.method === "DELETE") {
      if (++aborts === 1) { response.writeHead(503, { "content-type": "application/xml" }); response.end("<Error><Code>SlowDown</Code></Error>"); return }
      await admin.send(new AbortMultipartUploadCommand({ Bucket, Key: "ambiguous-remote", UploadId: remoteId }))
      response.writeHead(204); response.end()
    } else if (request.method === "GET") {
      await admin.send(new ListPartsCommand({ Bucket, Key: "ambiguous-remote", UploadId: remoteId }))
      response.writeHead(200, { "content-type": "application/xml" }); response.end(`<ListPartsResult><Bucket>${Bucket}</Bucket><Key>ambiguous-remote</Key><UploadId>${remoteId}</UploadId><IsTruncated>false</IsTruncated></ListPartsResult>`)
    } else { response.writeHead(501); response.end() }
  })().catch(() => response.destroy()) })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Invalid fault listener address")
  const origin = `http://127.0.0.1:${address.port}`
  process.env.STORAGE_S3_ALLOWED_ORIGINS += `,${origin}`
  const connection = await scopeA(() => saveStorageConnection({ name: "Fault provider", endpoint: origin, region: "us-east-1", ...upstreamCredentials }))
  await scopeA(() => setStorageCapabilities(connection.id, 1, Object.fromEntries(storageActions.map(action => [action, "supported"]))))
  const bucket = await scopeA(() => attachStorageBucket({ connectionId: connection.id, name: `fault-logical-${suffix}`, upstreamBucket: Bucket }))
  const temporary = await scopeA(() => createStorageKey({ name: "Fault client", bucketIds: [bucket.id], actions: [...storageActions] }))
  const faultClient = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", credentials: { accessKeyId: temporary.key.accessKeyId, secretAccessKey: temporary.secretAccessKey } })
  try {
    await expect(faultClient.send(new CreateMultipartUploadCommand({ Bucket: bucket.name, Key: "ambiguous-remote" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 500 } })
    expect(creates).toBe(1)
    const mapping = (await recoveryMultiparts()).find(value => value.bucketId === bucket.id)!
    expect(mapping.state).toBe("ambiguous")
    expect(mapping.remoteId).toBeUndefined()
    expect((await admin.send(new ListMultipartUploadsCommand({ Bucket }))).Uploads).toHaveLength(1)
    await expect(scopeA(() => resolveStorageMultipart(mapping.id, { remoteId }))).rejects.toThrow()
    expect(aborts).toBe(1)
    expect((await recoveryMultiparts()).find(value => value.id === mapping.id)).toMatchObject({ state: "aborting", remoteId })
    await scopeA(() => resolveStorageMultipart(mapping.id, {}))
    expect(aborts).toBe(2)
    expect((await recoveryMultiparts()).some(value => value.id === mapping.id)).toBe(false)
    expect((await admin.send(new ListMultipartUploadsCommand({ Bucket }))).Uploads || []).toHaveLength(0)
    await scopeA(() => detachStorageBucket(bucket.id))
    await scopeA(() => deleteStorageConnection(connection.id))
    await scopeA(() => revokeStorageKey(temporary.key.id))
  } finally {
    faultClient.destroy()
    if (remoteId) await admin.send(new AbortMultipartUploadCommand({ Bucket, Key: "ambiguous-remote", UploadId: remoteId })).catch(() => undefined)
    await admin.send(new DeleteBucketCommand({ Bucket }))
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

integration("installed AWS CLI and independent curl client use the live gateway", async () => {
  const directory = mkdtempSync(join(tmpdir(), "storage-clients-"))
  try {
    const config = join(directory, "config")
    writeFileSync(config, "[default]\nregion = us-east-1\ns3 =\n    addressing_style = path\n    signature_version = s3v4\n    multipart_threshold = 5MB\n    multipart_chunksize = 5MB\n")
    const env = { ...process.env, AWS_ACCESS_KEY_ID: issued.key.accessKeyId, AWS_SECRET_ACCESS_KEY: issued.secretAccessKey, AWS_EC2_METADATA_DISABLED: "true", AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: "/dev/null", AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED", AWS_RESPONSE_CHECKSUM_VALIDATION: "WHEN_REQUIRED" }
    if (process.env.STORAGE_TEST_AWS_CLI) {
      const command = Bun.spawn([process.env.STORAGE_TEST_AWS_CLI, "--endpoint-url", endpoint, "s3api", "list-buckets"], { env, stdout: "pipe", stderr: "pipe" })
      const output = await new Response(command.stdout).text(); const errors = await new Response(command.stderr).text()
      expect(await command.exited, errors).toBe(0)
      expect(JSON.parse(output).Buckets.map((value: { Name: string }) => value.Name)).toEqual([bucketA.name])
    }
    const curl = Bun.spawn(["curl", "--disable", "--silent", "--show-error", "--fail", "--aws-sigv4", "aws:amz:us-east-1:s3", "--user", `${issued.key.accessKeyId}:${issued.secretAccessKey}`, `${endpoint}/${bucketA.name}/?list-type=2`], { stdout: "pipe", stderr: "pipe" })
    const output = await new Response(curl.stdout).text(); const errors = await new Response(curl.stderr).text()
    expect(await curl.exited, errors).toBe(0)
    expect(output).toContain("ListBucketResult")
    expect(output).toContain(bucketA.name)
    const payload = join(directory, "payload")
    writeFileSync(payload, "cli-payload")
    if (process.env.STORAGE_TEST_AWS_CLI) {
      const command = Bun.spawn([process.env.STORAGE_TEST_AWS_CLI, "--endpoint-url", endpoint, "s3api", "put-object", "--bucket", bucketA.name, "--key", "cli-object", "--body", payload], { env, stdout: "pipe", stderr: "pipe" })
      const errors = await new Response(command.stderr).text()
      expect(await command.exited, errors).toBe(0)
      expect(await (await client.send(new GetObjectCommand({ Bucket: bucketA.name, Key: "cli-object" }))).Body?.transformToString()).toBe(readFileSync(payload, "utf8"))
      const large = join(directory, "multipart-payload")
      writeFileSync(large, "")
      const piece = new Uint8Array(1024 * 1024)
      for (let count = 0; count < 12; count++) appendFileSync(large, piece)
      const multipart = Bun.spawn([process.env.STORAGE_TEST_AWS_CLI, "--endpoint-url", endpoint, "s3", "cp", large, `s3://${bucketA.name}/cli-multipart`, "--no-progress"], { env, stdout: "pipe", stderr: "pipe" })
      const multipartError = await new Response(multipart.stderr).text()
      expect(await multipart.exited, multipartError).toBe(0)
      expect((await client.send(new HeadObjectCommand({ Bucket: bucketA.name, Key: "cli-multipart" }))).ContentLength).toBe(12 * 1024 * 1024)
      if (process.env.STORAGE_TEST_S3CMD) {
        const destination = join(directory, "s3cmd-result")
        const host = new URL(endpoint).host
        const independent = Bun.spawn([process.env.STORAGE_TEST_S3CMD, "--config=/dev/null", `--access_key=${issued.key.accessKeyId}`, `--secret_key=${issued.secretAccessKey}`, `--host=${host}`, `--host-bucket=${host}`, "--no-ssl", "--no-progress", "get", `s3://${bucketA.name}/cli-object`, destination], { stdout: "pipe", stderr: "pipe" })
        const errors = await new Response(independent.stderr).text()
        expect(await independent.exited, errors).toBe(0)
        expect(readFileSync(destination, "utf8")).toBe("cli-payload")
      }
    }
  } finally { rmSync(directory, { recursive: true }) }
}, 60_000)

test("revoked key is denied by the actual listener", async () => {
  const temporary = await scopeA(() => createStorageKey({ name: "Revoke", bucketIds: [bucketA.id], actions: ["ListBuckets"] }))
  await scopeA(() => revokeStorageKey(temporary.key.id))
  const revoked = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: temporary.key.accessKeyId, secretAccessKey: temporary.secretAccessKey } })
  try { await expect(revoked.send(new ListBucketsCommand({}))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } }) } finally { revoked.destroy() }
})

test("ambiguous initiation retains durable cleanup ownership and blocks deletion until explicit resolution", async () => {
  const snapshot = await recoveryConnection(connectionA.id, workspaceA.id)
  const ambiguous = await scopeA(() => beginMultipart(bucketA, issued.key.id, "uncertain-create", snapshot))
  expect(await recoverStorageMultiparts()).toBe(1)
  expect((await recoveryMultiparts()).find(value => value.id === ambiguous.id)?.state).toBe("ambiguous")
  await expect(scopeA(() => resolveStorageMultipart(ambiguous.id, { confirmedAbsent: true, remoteId: "conflicting" }))).rejects.toThrow("Invalid conflicting")
  await expect(scopeA(() => detachStorageBucket(bucketA.id))).rejects.toThrow("ambiguous")
  await scopeA(() => resolveStorageMultipart(ambiguous.id, { confirmedAbsent: true }))
  await scopeA(() => detachStorageBucket(bucketA.id))
  expect((await scopeA(storageDashboard)).buckets).toHaveLength(0)
  await expect(client.send(new GetObjectCommand({ Bucket: bucketA.name, Key: key }))).rejects.toMatchObject({ name: "AccessDenied" })
  bucketA = await scopeA(() => attachStorageBucket({ connectionId: connectionA.id, name: bucketA.name, upstreamBucket: upstreamBuckets[0]! }))
  await scopeA(() => updateStorageKeyPolicy(issued.key.id, { bucketIds: [bucketA.id], actions: [...storageActions] }))
})

test("workspace deletion revokes and removes only local Storage resources", async () => {
  const response = provider ? await client.send(new GetObjectCommand({ Bucket: bucketA.name, Key: "large-stream" })) : undefined
  let deleted = false
  const deleting = deleteWorkspace(workspaceA.id, workspaceA.name).then(() => { deleted = true })
  if (response) {
    await Bun.sleep(25)
    expect(deleted).toBe(false)
    await response.Body!.transformToWebStream().cancel()
  }
  await deleting
  expect(await getWorkspace(workspaceA.id)).toBeUndefined()
  expect(getDatabase().query("SELECT id FROM storage_records WHERE workspace_id=?").all(workspaceA.id)).toHaveLength(0)
  expect(getDatabase().query("SELECT id FROM storage_records WHERE workspace_id=?").all(workspaceB.id).length).toBeGreaterThan(0)
  if (provider) expect(await (await admin.send(new GetObjectCommand({ Bucket: upstreamBuckets[0], Key: key }))).Body?.transformToString()).toBe("hello-storage")
})
