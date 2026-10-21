import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import { once } from "node:events"
import { XMLParser, XMLValidator } from "fast-xml-parser"
import { getWorkspace } from "@rawroute/platform/server/runtime"
import { runInWorkspace } from "@rawroute/platform/server/workspace-context"
import { runWithGatewayAuditIdentity } from "@rawroute/observability/server/audit-context"
import { runInRequest, requestContext } from "@rawroute/observability/server/request-context"
import { classifyStorageRequest, StorageProtocolError, storageErrorResponse } from "./protocol"
import { lookupStorageCredential, authorizeStorage, connectionCredentials, storageRemoteAudit, beginMultipart, updateMultipart, finishMultipart, getMultipart, listClientMultiparts } from "./repository"
import { verifyStorageSignature, StorageSignatureError } from "./signature"
import { storageUploadBody, StorageStreamAdmission, StorageBodyError } from "./streams"
import { createStorageUpstream, StorageUpstreamError } from "./upstream"
import { admitStorageBucket, serializeMultipart } from "./service"
import { storageRecordLog } from "./logging"
import type { StorageResolver } from "./security"

const maximumObjectBytes = 5 * 1024 ** 3
const maximumConcurrentRequests = 32
const maximumWorkspaceRequests = 16
const maximumConnections = 128
const drainTimeoutMs = 30_000

const escapeXml = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
const element = (name: string, value: unknown) => `<${name}>${escapeXml(value)}</${name}>`
function incomingBody(incoming: IncomingMessage, onRead: () => void) {
  const iterator = incoming[Symbol.asyncIterator]()
  let started = false
  return new ReadableStream<Uint8Array>({ async pull(controller) { try { if (!started) { started = true; onRead() } const result = await iterator.next(); if (result.done) controller.close(); else controller.enqueue(result.value) } catch (error) { controller.error(error) } }, cancel() { incoming.pause() } }, { highWaterMark: 0 })
}
function xml(root: string, value: string, status = 200) { return new Response(`<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${value}</${root}>`, { status, headers: { "content-type": "application/xml" } }) }

function rawRequest(incoming: IncomingMessage) {
  const target = incoming.url || ""
  const host = incoming.headers.host || ""
  if (!target.startsWith("/") || target.startsWith("//") || /[\x00-\x20#\\]/.test(target) || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::\d{1,5})?$/.test(host)) throw new StorageProtocolError("InvalidRequest", 400)
  const seen = new Set<string>()
  const headers = new Headers()
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index]!.toLowerCase()
    if (seen.has(name)) throw new StorageProtocolError("InvalidRequest", 400)
    seen.add(name); headers.set(name, incoming.rawHeaders[index + 1]!)
  }
  if (headers.has("transfer-encoding") && headers.has("content-length")) throw new StorageProtocolError("InvalidRequest", 400)
  if (headers.has("expect") && headers.get("expect")?.toLowerCase() !== "100-continue") throw new StorageProtocolError("InvalidRequest", 400)
  const rawUrl = `http://${host}${target}`
  return { request: new Request(rawUrl, { method: incoming.method || "GET", headers }), rawUrl }
}

async function pump(response: Response, outgoing: ServerResponse, method: string, signal: AbortSignal) {
  outgoing.statusCode = response.status
  for (const [name, value] of response.headers) outgoing.setHeader(name, value)
  // One request/socket avoids reusing a connection with an unconsumed error body.
  outgoing.setHeader("connection", "close")
  if (!response.body || method === "HEAD") { await response.body?.cancel(); outgoing.end(); return }
  const reader = response.body.getReader()
  try {
    while (!signal.aborted) {
      const result = await reader.read()
      if (result.done) break
      if (!outgoing.write(result.value)) await once(outgoing, "drain", { signal })
    }
    if (signal.aborted) throw new Error("Client disconnected")
    outgoing.end()
    if (!outgoing.writableFinished) await once(outgoing, "finish", { signal })
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

function errorResponse(error: unknown, requestId: string) {
  if (error instanceof StorageSignatureError) return storageErrorResponse("SignatureDoesNotMatch", requestId, 403)
  if (error instanceof StorageProtocolError) return storageErrorResponse(error.code, requestId, error.status)
  if (error instanceof StorageBodyError) return storageErrorResponse(error.code, requestId, error.code === "EntityTooLarge" ? 413 : 400)
  const code = error instanceof StorageUpstreamError ? error.code : error instanceof Error ? error.message : ""
  if (code === "NotImplemented") return storageErrorResponse(code, requestId, 501)
  if (code === "NoSuchKey" || code === "NoSuchBucket" || code === "NoSuchUpload") return storageErrorResponse(code, requestId, 404)
  if (code === "InvalidRange") return storageErrorResponse(code, requestId, 416)
  if (code === "AccessDenied" || code === "Storage resource not found." || code === "Workspace is unavailable.") return storageErrorResponse("AccessDenied", requestId, 403)
  return storageErrorResponse("InternalError", requestId, 500)
}

function objectHeaders(value: { ETag?: string; ContentLength?: number; ContentType?: string; LastModified?: Date; ContentRange?: string; CacheControl?: string; ContentDisposition?: string; ContentEncoding?: string; ContentLanguage?: string; Expires?: Date; Metadata?: Record<string, string> }, ranges: boolean) {
  const headers = new Headers()
  if (ranges) headers.set("accept-ranges", "bytes")
  if (value.ETag) headers.set("etag", value.ETag)
  if (value.ContentLength !== undefined) headers.set("content-length", String(value.ContentLength))
  if (value.ContentType) headers.set("content-type", value.ContentType)
  if (value.LastModified) headers.set("last-modified", value.LastModified.toUTCString())
  if (value.ContentRange) headers.set("content-range", value.ContentRange)
  if (value.CacheControl) headers.set("cache-control", value.CacheControl)
  if (value.ContentDisposition) headers.set("content-disposition", value.ContentDisposition)
  if (value.ContentEncoding) headers.set("content-encoding", value.ContentEncoding)
  if (value.ContentLanguage) headers.set("content-language", value.ContentLanguage)
  if (value.Expires) headers.set("expires", value.Expires.toUTCString())
  for (const [name, entry] of Object.entries(value.Metadata || {})) headers.set(`x-amz-meta-${name}`, entry)
  return headers
}

async function completeParts(body: ReadableStream<Uint8Array>) {
  const value = (await new Response(body).text()).replace(/^\s*<\?xml\s[^?]*\?>/, "")
  if (/<!|<\?/.test(value) || XMLValidator.validate(value) !== true) throw new StorageProtocolError("InvalidRequest", 400)
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: true, isArray: name => name === "Part" }).parse(value) as { CompleteMultipartUpload?: { Part?: { ETag?: string; PartNumber?: string }[] } }
  const root = parsed.CompleteMultipartUpload
  const parts = root?.Part
  if (!root || Object.keys(root).some(key => key !== "Part" && key !== "@_xmlns") || !Array.isArray(parts) || !parts.length || parts.length > 10000) throw new StorageProtocolError("InvalidRequest", 400)
  let previous = 0
  return parts.map(part => {
    const number = Number(part.PartNumber)
    if (Object.keys(part).some(key => !["ETag", "PartNumber"].includes(key)) || !Number.isInteger(number) || number <= previous || number > 10000 || typeof part.ETag !== "string" || !/^"?[a-fA-F0-9-]{1,128}"?$/.test(part.ETag)) throw new StorageProtocolError("InvalidRequest", 400)
    previous = number
    return { PartNumber: number, ETag: part.ETag }
  })
}

async function dispatch(request: Request, rawUrl: string, incoming: IncomingMessage, keyId: string, payloadHash: string, signal: AbortSignal, onRead: () => void, region: string, resolver?: StorageResolver) {
  const operation = classifyStorageRequest(request, rawUrl)
  if (!["PutObject", "UploadPart", "CompleteMultipartUpload"].includes(operation.action)) {
    if (request.headers.has("transfer-encoding") || Number(request.headers.get("content-length") || "0") !== 0) throw new StorageProtocolError("InvalidRequest", 400)
    if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") throw new StorageBodyError("XAmzContentSHA256Mismatch")
  }
  const authorized = await authorizeStorage(keyId, operation.bucket, operation.action)
  if (operation.action === "ListBuckets") return { response: xml("ListAllMyBucketsResult", `<Buckets>${authorized.buckets.map(bucket => `<Bucket>${element("Name", bucket.name)}${element("CreationDate", bucket.createdAt || "1970-01-01T00:00:00Z")}</Bucket>`).join("")}</Buckets>`), release: () => undefined }
  const bucket = authorized.bucket!
  const connection = authorized.connection!
  const release = admitStorageBucket(bucket.id)
  let upstream: Awaited<ReturnType<typeof createStorageUpstream>> | undefined
  let uploadError: unknown
  try {
    const ranges = connection.options?.ranges?.status === "supported" && connection.options.ranges.connectionRevision === connection.revision
    if (operation.range && !ranges) throw new StorageProtocolError("NotImplemented", 501)
    const exactKey = operation.key.includes("//") || operation.key.includes("\\") || /%[a-f0-9]{2}|[\x00-\x1f\x7f]/i.test(operation.key) || operation.key.split("/").some(segment => segment === "." || segment === "..")
    if (exactKey && (connection.options?.exactKeys?.status !== "supported" || connection.options.exactKeys.connectionRevision !== connection.revision)) throw new StorageProtocolError("NotImplemented", 501)
    upstream = await createStorageUpstream({ connection, upstreamBucket: bucket.upstreamBucket, credentials: connectionCredentials(connection), resolver })
    const client = upstream
    const upload = (maximum = maximumObjectBytes) => {
      const length = request.headers.get("content-length") || "0"
      if (!/^\d+$/.test(length) || request.headers.has("transfer-encoding")) throw new StorageProtocolError("InvalidRequest", 400)
      if (Number(length) === 0 && payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") throw new StorageBodyError("XAmzContentSHA256Mismatch")
      return { length: Number(length), body: storageUploadBody(incomingBody(incoming, onRead), { maximumBytes: maximum, contentLength: Number(length), payloadHash, onError(error) { uploadError = error } }) }
    }
    const write = async <T>(callback: () => Promise<T>) => {
      await storageRemoteAudit("storage-object", "started")
      try { const result = await callback(); await storageRemoteAudit("storage-object", "success"); return result } catch (error) { await storageRemoteAudit("storage-object", "failure"); throw error }
    }
    let response: Response
    switch (operation.action) {
      case "HeadBucket": await client.headBucket(signal); response = new Response(null); break
      case "GetBucketLocation": { await client.getBucketLocation(signal); response = xml("LocationConstraint", escapeXml(region === "us-east-1" ? "" : region)); break }
      case "ListMultipartUploads": {
        const q = operation.query
        const maximum = Number(q["max-uploads"] || 1000)
        const all = (await listClientMultiparts(bucket.id, keyId)).filter(value => value.key.startsWith(q.prefix || "") && (!q["key-marker"] || value.key > q["key-marker"]! || value.key === q["key-marker"] && q["upload-id-marker"] !== undefined && value.id > q["upload-id-marker"])).sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)) || a.id.localeCompare(b.id))
        const entries = all.slice(0, maximum)
        const last = entries.at(-1)
        response = xml("ListMultipartUploadsResult", element("Bucket", bucket.name) + element("KeyMarker", q["key-marker"] || "") + element("UploadIdMarker", q["upload-id-marker"] || "") + element("MaxUploads", maximum) + element("IsTruncated", all.length > entries.length) + (all.length > entries.length && last ? element("NextKeyMarker", last.key) + element("NextUploadIdMarker", last.id) : "") + (q.prefix ? element("Prefix", q.prefix) : "") + entries.map(value => `<Upload>${element("Key", value.key)}${element("UploadId", value.id)}${element("Initiated", value.createdAt)}${element("StorageClass", "STANDARD")}</Upload>`).join(""))
        break
      }
      case "ListObjectsV2": {
        const q = operation.query
        const result = await client.listObjects({ Prefix: q.prefix, Delimiter: q.delimiter, ContinuationToken: q["continuation-token"], MaxKeys: q["max-keys"] === undefined ? undefined : Number(q["max-keys"]), StartAfter: q["start-after"], EncodingType: q["encoding-type"] as "url" | undefined }, signal)
        response = xml("ListBucketResult", element("Name", bucket.name) + element("Prefix", result.Prefix || "") + element("KeyCount", result.KeyCount || 0) + element("MaxKeys", result.MaxKeys ?? 1000) + element("IsTruncated", result.IsTruncated || false) + (result.Delimiter !== undefined ? element("Delimiter", result.Delimiter) : "") + (result.ContinuationToken ? element("ContinuationToken", result.ContinuationToken) : "") + (result.NextContinuationToken ? element("NextContinuationToken", result.NextContinuationToken) : "") + (result.StartAfter ? element("StartAfter", result.StartAfter) : "") + (result.EncodingType ? element("EncodingType", result.EncodingType) : "") + (result.Contents || []).map(value => `<Contents>${element("Key", value.Key)}${element("LastModified", value.LastModified?.toISOString())}${element("ETag", value.ETag)}${element("Size", value.Size)}${element("StorageClass", value.StorageClass || "STANDARD")}</Contents>`).join("") + (result.CommonPrefixes || []).map(value => `<CommonPrefixes>${element("Prefix", value.Prefix)}</CommonPrefixes>`).join(""))
        break
      }
      case "HeadObject": { const result = await client.headObject(operation.key, signal); response = new Response(null, { headers: objectHeaders(result, ranges) }); break }
      case "GetObject": { const result = await client.getObject(operation.key, operation.range || undefined, signal); response = new Response(result.Body?.transformToWebStream(), { status: result.ContentRange ? 206 : 200, headers: objectHeaders(result, ranges) }); break }
      case "PutObject": {
        const input = upload()
        const result = await write(() => client.putObject({ Key: operation.key, Body: input.body, ContentLength: input.length, ContentType: request.headers.get("content-type") || undefined }, signal))
        response = new Response(null, { headers: result.ETag ? { etag: result.ETag } : {} }); break
      }
      case "DeleteObject": await write(() => client.deleteObject(operation.key, signal)); response = new Response(null, { status: 204 }); break
      case "CreateMultipartUpload": {
        const id = crypto.randomUUID()
        response = await serializeMultipart(id, async () => {
          // Acquire before publishing a visible intent: cleanup/resolution must
          // wait until remote initiation and its durable outcome have settled.
          const value = await beginMultipart(bucket, keyId, operation.key, connection, id)
          try {
            const result = await client.createMultipart({ Key: operation.key, ContentType: request.headers.get("content-type") || undefined }, signal)
            if (!result.UploadId) throw new Error("Missing remote upload identifier")
            value.remoteId = result.UploadId; value.state = "active"; await updateMultipart(value)
            return xml("InitiateMultipartUploadResult", element("Bucket", bucket.name) + element("Key", operation.key) + element("UploadId", value.id))
          } catch (error) { await updateMultipart({ ...value, state: value.remoteId ? "aborting" : "ambiguous" }, "failure"); throw error }
        })
        break
      }
      default: {
        response = await serializeMultipart(operation.query.uploadId!, async () => {
          const value = await getMultipart(operation.query.uploadId!, bucket, keyId, operation.key)
          const remote = { Key: operation.key, UploadId: value.remoteId! }
          await storageRemoteAudit("storage-multipart", "started")
          try {
            let resultResponse: Response
            if (operation.action === "UploadPart") {
              const input = upload()
              const result = await client.uploadPart({ ...remote, PartNumber: Number(operation.query.partNumber), Body: input.body, ContentLength: input.length }, signal)
              resultResponse = new Response(null, { headers: result.ETag ? { etag: result.ETag } : {} })
            } else if (operation.action === "ListParts") {
              const result = await client.listParts({ ...remote, PartNumberMarker: operation.query["part-number-marker"], MaxParts: operation.query["max-parts"] ? Number(operation.query["max-parts"]) : undefined }, signal)
              resultResponse = xml("ListPartsResult", element("Bucket", bucket.name) + element("Key", operation.key) + element("UploadId", value.id) + element("PartNumberMarker", result.PartNumberMarker || 0) + element("NextPartNumberMarker", result.NextPartNumberMarker || 0) + element("MaxParts", result.MaxParts ?? 1000) + element("IsTruncated", result.IsTruncated || false) + (result.Parts || []).map(part => `<Part>${element("PartNumber", part.PartNumber)}${element("LastModified", part.LastModified?.toISOString())}${element("ETag", part.ETag)}${element("Size", part.Size)}</Part>`).join(""))
            } else if (operation.action === "CompleteMultipartUpload") {
              const parts = await completeParts(upload(1024 * 1024).body)
              value.state = "completing"; await updateMultipart(value, "started")
              const result = await client.completeMultipart({ ...remote, Parts: parts }, signal)
              await finishMultipart(value)
              resultResponse = xml("CompleteMultipartUploadResult", element("Bucket", bucket.name) + element("Key", operation.key) + element("ETag", result.ETag))
            } else {
              value.state = "aborting"; await updateMultipart(value, "started")
              try { await client.abortMultipart(remote, signal) } catch (error) { if (!(error instanceof StorageUpstreamError && error.code === "NoSuchUpload")) throw error }
              await finishMultipart(value); resultResponse = new Response(null, { status: 204 })
            }
            await storageRemoteAudit("storage-multipart", "success"); return resultResponse
          } catch (error) { await storageRemoteAudit("storage-multipart", "failure"); throw error }
        })
      }
    }
    return { response, release: () => { upstream!.close(); release() } }
  } catch (error) { upstream?.close(); release(); throw uploadError || error }
}

export async function startStorageListener(options: { port: number; hostname: string; region: string; resolver?: StorageResolver }) {
  if (!/^[a-z0-9-]{1,64}$/.test(options.region)) throw new Error("Invalid Storage signing region.")
  const maximum = maximumConcurrentRequests
  const admission = new StorageStreamAdmission(maximum, maximumWorkspaceRequests)
  const handleRequest = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const requestId = requestContext().requestId || crypto.randomUUID()
    const abort = new AbortController()
    incoming.on("aborted", () => abort.abort())
    outgoing.on("close", () => { if (!outgoing.writableFinished) abort.abort() })
    try {
      const { request, rawUrl } = rawRequest(incoming)
      const verified = await verifyStorageSignature(request, { region: options.region, lookup: lookupStorageCredential, rawUrl })
      const workspace = await getWorkspace(verified.workspaceId)
      if (!workspace || workspace.status !== "active") throw new Error("AccessDenied")
      const lease = admission.admit(workspace.id)
      try {
        await runInWorkspace(workspace, () => runWithGatewayAuditIdentity(verified.keyId, async () => {
          const result = await dispatch(request, rawUrl, incoming, verified.keyId, verified.payloadHash, abort.signal, () => { if (incoming.headers.expect) outgoing.writeContinue() }, options.region, options.resolver)
          try { result.response.headers.set("x-amz-request-id", requestId); await pump(result.response, outgoing, request.method, abort.signal); storageRecordLog("storage.request.completed", { method: request.method, status: result.response.status }) } finally { result.release() }
        }))
      } finally { lease.release() }
    } catch (error) {
      const response = error instanceof Error && error.message === "Storage admission unavailable." ? storageErrorResponse("SlowDown", requestId, 503) : errorResponse(error, requestId)
      storageRecordLog("storage.request.failed", { status: response.status }, { level: "warn" })
      if (outgoing.headersSent) outgoing.destroy()
      else {
        for (const name of outgoing.getHeaderNames()) outgoing.removeHeader(name)
        await pump(response, outgoing, incoming.method || "GET", abort.signal).catch(() => outgoing.destroy())
      }
    }
  }
  const handle = (incoming: IncomingMessage, outgoing: ServerResponse) => runInRequest(() => handleRequest(incoming, outgoing))
  const server: Server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 300_000, headersTimeout: 15_000, keepAliveTimeout: 1000 }, (incoming, outgoing) => { void handle(incoming, outgoing) })
  server.maxConnections = maximumConnections
  server.maxRequestsPerSocket = 1
  server.on("checkContinue", (incoming, outgoing) => { void handle(incoming, outgoing) })
  server.on("checkExpectation", (incoming, outgoing) => { void handle(incoming, outgoing) })
  server.on("clientError", (error, socket) => {
    if (!socket.writable) return
    const code = "code" in error && error.code === "HPE_HEADER_OVERFLOW" ? 431 : 400
    const body = '<Error><Code>InvalidRequest</Code><Message>InvalidRequest</Message></Error>'
    socket.end(`HTTP/1.1 ${code} Bad Request\r\nContent-Type: application/xml\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.hostname, () => { server.off("error", reject); resolve() }) })
  return {
    address: server.address(),
    async stop() {
      const drained = admission.stop()
      const closed = new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
      server.closeIdleConnections()
      const force = setTimeout(() => server.closeAllConnections(), drainTimeoutMs)
      try { await Promise.all([drained, closed]) } finally { clearTimeout(force) }
    },
  }
}
