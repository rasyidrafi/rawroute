import { readFileSync, writeFileSync } from "node:fs"
import { Readable } from "node:stream"
import { S3Client, CreateBucketCommand, DeleteBucketCommand, ListBucketsCommand, ListObjectsV2Command, HeadBucketCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, ListPartsCommand, ListMultipartUploadsCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { storageActions } from "../../packages/gateway-storage/src/contracts"

if (process.env.STORAGE_SMOKE_DISPOSABLE !== "yes") throw new Error("This diagnostic requires explicit disposable-environment acknowledgment.")
const adminUrl = process.env.STORAGE_SMOKE_ADMIN_URL!
const s3Url = process.env.STORAGE_SMOKE_S3_URL!
const upstreamUrl = process.env.STORAGE_SMOKE_UPSTREAM_URL!
const stateFile = process.env.STORAGE_SMOKE_STATE || "/smoke/state.json"
const phase = process.argv[2]
if (!adminUrl || !s3Url || !upstreamUrl || !["prepare", "recover"].includes(phase || "")) throw new Error("Supply explicit disposable URLs and prepare/recover phase.")
function assert(value: unknown, label: string): asserts value { if (!value) throw new Error(`Storage smoke failed: ${label}`) }
for (let attempt = 0; attempt < 120; attempt++) {
  try { if ((await fetch(`${adminUrl}/api/live`, { signal: AbortSignal.timeout(2000) })).ok) break } catch {}
  if (attempt === 119) throw new Error("Disposable gateway startup timed out")
  await Bun.sleep(500)
}
let cookie = ""
async function call(path: string, method = "GET", body?: unknown, workspaceId?: string) {
  const response = await fetch(`${adminUrl}${path}`, { method, headers: { origin: adminUrl, ...(cookie ? { cookie } : {}), ...(workspaceId ? { "x-rawroute-workspace-id": workspaceId } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })
  assert(response.ok, `${method} ${path}: ${response.status}`)
  return response
}
if (phase === "prepare") {
  const bootstrap = await (await call("/api/auth/bootstrap")).json() as { defaultPasswordHint: string | null }
  assert(bootstrap.defaultPasswordHint === "123456", "public hostname displays the fixed default")
} else {
  const previous = JSON.parse(readFileSync(stateFile, "utf8")) as { adminCookie: string }
  cookie = previous.adminCookie
  assert((await (await call("/api/auth/session")).json() as { authenticated: boolean }).authenticated, "saved administrator session survives restart")
  assert((await (await call("/api/auth/bootstrap")).json() as { defaultPasswordHint: string | null }).defaultPasswordHint === null, "rotated password is not displayed")
}
let login = await fetch(`${adminUrl}/api/auth/login`, { method: "POST", headers: { origin: adminUrl, "content-type": "application/json" }, body: JSON.stringify({ password: "123456" }) })
if (!login.ok) login = await fetch(`${adminUrl}/api/auth/login`, { method: "POST", headers: { origin: adminUrl, "content-type": "application/json" }, body: JSON.stringify({ password: "TEST-storage-smoke-private-password" }) })
assert(login.ok, "administrator login")
cookie = login.headers.get("set-cookie")!.split(";")[0]!
if ((await login.json() as { mustChangePassword: boolean }).mustChangePassword) {
  assert((await fetch(`${adminUrl}/api/admin/workspaces`, { headers: { cookie } })).status === 403, "public first login requires password change")
  await call("/api/admin/account/password", "POST", { password: "TEST-storage-smoke-private-password" })
}
const gatewayKeys = (await (await call("/api/admin/endpoint-key", "GET", undefined, "default")).json() as { apiKeys: { key: string }[] }).apiKeys
assert(gatewayKeys.length === 1 && /^sk-[a-f0-9]{64}$/.test(gatewayKeys[0]!.key), "one cryptographically generated initial AI gateway key")
const upstream = new S3Client({ endpoint: upstreamUrl, region: "us-east-1", credentials: { accessKeyId: "disposable-upstream", secretAccessKey: "disposable-upstream-secret" }, forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" })
type State = { workspaceId: string; workspaceName: string; logicalBucket: string; upstreamBucket: string; accessKeyId: string; secretAccessKey: string; pendingId: string; key: string; adminCookie: string; gatewayKey: string }
let client: S3Client | undefined
try {
  let state: State
  if (phase === "prepare") {
    const suffix = crypto.randomUUID().slice(0, 8)
    const workspaceName = `TEST Storage smoke ${suffix}`
    const workspace = await (await call("/api/admin/workspaces", "POST", { name: workspaceName })).json() as { workspace?: { id: string }; id?: string }
    const workspaces = await (await call("/api/admin/workspaces")).json() as { workspaces: { id: string; name: string }[] }
    const workspaceId = workspace.workspace?.id || workspace.id || workspaces.workspaces.find(value => value.name === workspaceName)?.id
    assert(workspaceId, "created workspace")
    const logicalBucket = `logical-smoke-${suffix}`
    const upstreamBucket = `upstream-smoke-${suffix}`
    await upstream.send(new CreateBucketCommand({ Bucket: upstreamBucket }))
    const mutate = async (body: unknown) => (await (await call("/api/admin/storage", "POST", body, workspaceId)).json() as { value: Record<string, unknown> }).value
    const connection = await mutate({ action: "save-connection", name: "TEST native S3", endpoint: upstreamUrl, region: "us-east-1", accessKeyId: "disposable-upstream", secretAccessKey: "disposable-upstream-secret" })
    await mutate({ action: "capabilities", id: connection.id, revision: connection.revision, statuses: Object.fromEntries(storageActions.map(action => [action, "supported"])), ranges: "supported" })
    const bucket = await mutate({ action: "attach-bucket", connectionId: connection.id, name: logicalBucket, upstreamBucket })
    const issued = await mutate({ action: "create-key", name: "TEST independent client", bucketIds: [bucket.id], actions: storageActions }) as { key: { accessKeyId: string }; secretAccessKey: string }
    state = { workspaceId, workspaceName, logicalBucket, upstreamBucket, accessKeyId: issued.key.accessKeyId, secretAccessKey: issued.secretAccessKey, pendingId: "", key: "folder/日本語 plus+percent%", adminCookie: cookie, gatewayKey: gatewayKeys[0]!.key }
  } else state = JSON.parse(readFileSync(stateFile, "utf8")) as State
  assert(state.gatewayKey === gatewayKeys[0]!.key, "generated AI gateway key survives restart")
  client = new S3Client({ endpoint: s3Url, region: "us-east-1", credentials: { accessKeyId: state.accessKeyId, secretAccessKey: state.secretAccessKey }, forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" })
  const Bucket = state.logicalBucket
  assert((await client.send(new ListBucketsCommand({}))).Buckets?.map(value => value.Name).join() === Bucket, "workspace-filtered ListBuckets")
  if (phase === "prepare") {
    const missingScope = await fetch(`${adminUrl}/api/admin/storage`, { headers: { cookie } })
    assert(missingScope.status === 400, "management requires explicit workspace")
    await client.send(new HeadBucketCommand({ Bucket }))
    await client.send(new PutObjectCommand({ Bucket, Key: state.key, Body: "smoke-native-body", ContentType: "text/plain" }))
    assert((await client.send(new HeadObjectCommand({ Bucket, Key: state.key }))).ContentLength === 17, "HEAD preserves content length")
    assert(await (await client.send(new GetObjectCommand({ Bucket, Key: state.key }))).Body?.transformToString() === "smoke-native-body", "native object roundtrip")
    assert(await (await client.send(new GetObjectCommand({ Bucket, Key: state.key, Range: "bytes=0-4" }))).Body?.transformToString() === "smoke", "range GET")
    assert((await client.send(new ListObjectsV2Command({ Bucket, Prefix: "folder/" }))).Contents?.[0]?.Key === state.key, "unicode/list key preservation")
    const presigned = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key: state.key }), { expiresIn: 60 })
    assert(await (await fetch(presigned)).text() === "smoke-native-body", "presigned GET")
    const presignedPut = await getSignedUrl(client, new PutObjectCommand({ Bucket, Key: "presigned-put" }), { expiresIn: 60 })
    assert((await fetch(presignedPut, { method: "PUT", body: "presigned" })).ok, "presigned PUT")
    const multipart = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: "multipart-completed" }))
    const part = await client.send(new UploadPartCommand({ Bucket, Key: "multipart-completed", UploadId: multipart.UploadId, PartNumber: 1, Body: "multipart-smoke" }))
    assert((await client.send(new ListPartsCommand({ Bucket, Key: "multipart-completed", UploadId: multipart.UploadId }))).Parts?.length === 1, "ListParts")
    await client.send(new CompleteMultipartUploadCommand({ Bucket, Key: "multipart-completed", UploadId: multipart.UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] } }))
    assert(await (await client.send(new GetObjectCommand({ Bucket, Key: "multipart-completed" }))).Body?.transformToString() === "multipart-smoke", "multipart completion")
    const size = 32 * 1024 * 1024
    const stream = Readable.from((async function* () { for (let position = 0; position < size; position += 64 * 1024) yield new Uint8Array(64 * 1024) })())
    await client.send(new PutObjectCommand({ Bucket, Key: "large-stream", Body: stream, ContentLength: size }))
    let received = 0
    for await (const chunk of (await client.send(new GetObjectCommand({ Bucket, Key: "large-stream" }))).Body!.transformToWebStream()) received += chunk.byteLength
    assert(received === size, "32 MiB real Docker stream")
    const pending = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: "restart-owned" }))
    state.pendingId = pending.UploadId!
    assert((await client.send(new ListMultipartUploadsCommand({ Bucket }))).Uploads?.[0]?.UploadId === state.pendingId, "owned logical multipart listing")
    writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 })
    console.log("PASS current built runtime: authenticated management, native SDK core/range/encoded keys/presigned GET+PUT/multipart/32 MiB streaming; restart intent persisted")
  } else {
    const pending = await upstream.send(new ListMultipartUploadsCommand({ Bucket: state.upstreamBucket }))
    assert(!pending.Uploads?.length, "restart aborted owned remote multipart")
    const dashboard = await (await call("/api/admin/storage", "GET", undefined, state.workspaceId)).json() as { multiparts: unknown[]; buckets: { id: string }[] }
    assert(dashboard.multiparts.length === 0, "restart retired local mapping after remote cleanup")
    await client.send(new CreateMultipartUploadCommand({ Bucket, Key: "workspace-delete-owned" }))
    const download = await client.send(new GetObjectCommand({ Bucket, Key: "large-stream" }))
    let deleted = false
    const deleting = call(`/api/admin/workspaces/${state.workspaceId}`, "DELETE", { confirmation: state.workspaceName }).then(() => { deleted = true })
    await Bun.sleep(50)
    assert(!deleted, "workspace deletion drains admitted response body")
    await download.Body!.transformToWebStream().cancel()
    await deleting
    assert(await (await upstream.send(new GetObjectCommand({ Bucket: state.upstreamBucket, Key: state.key }))).Body?.transformToString() === "smoke-native-body", "deletion preserves attached remote data")
    assert(!(await upstream.send(new ListMultipartUploadsCommand({ Bucket: state.upstreamBucket }))).Uploads?.length, "deletion cleans multipart")
    let rejected = false
    try { await client.send(new ListBucketsCommand({})) } catch { rejected = true }
    assert(rejected, "deleted workspace client key denied")
    const objects = await upstream.send(new ListObjectsV2Command({ Bucket: state.upstreamBucket }))
    for (const value of objects.Contents || []) await upstream.send(new DeleteObjectCommand({ Bucket: state.upstreamBucket, Key: value.Key }))
    await upstream.send(new DeleteBucketCommand({ Bucket: state.upstreamBucket }))
    console.log("PASS current built runtime restart/recovery, streamed deletion drain, key invalidation, remote multipart cleanup and remote object preservation")
  }
} finally { client?.destroy(); upstream.destroy() }
