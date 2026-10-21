import type { StorageAction } from "../contracts"
import { parseStorageRequestTarget } from "./signature"

export class StorageProtocolError extends Error {
  constructor(readonly code: "InvalidRequest" | "NotImplemented" | "MethodNotAllowed", readonly status: number) { super(code) }
}

const queryOptions = new Set(["list-type", "prefix", "delimiter", "continuation-token", "max-keys", "start-after", "encoding-type", "location", "uploads", "uploadId", "partNumber", "part-number-marker", "max-parts", "max-uploads", "key-marker", "upload-id-marker"])
const signatureQuery = new Set(["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-SignedHeaders", "X-Amz-Signature", "X-Amz-Content-Sha256", "x-id"])
const allowedAmzHeaders = new Set(["x-amz-date", "x-amz-content-sha256", "x-amz-user-agent"])
const unsupportedHeaders = new Set(["content-md5", "content-encoding", "content-range", "content-disposition", "content-language", "cache-control", "expires", "if-range", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since"])

/** Explicitly reject unsupported semantics before any upstream side effect. */
export function classifyStorageRequest(request: Request, rawUrl?: string) {
  const target = parseStorageRequestTarget(rawUrl || request.url)
  for (const [name] of request.headers) {
    if (name.startsWith("x-amz-") && !allowedAmzHeaders.has(name)) throw new StorageProtocolError("NotImplemented", 501)
    if (unsupportedHeaders.has(name)) throw new StorageProtocolError("NotImplemented", 501)
  }
  const query: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [name, value] of Object.entries(target.query)) {
    if (Array.isArray(value)) throw new StorageProtocolError("InvalidRequest", 400)
    if (!queryOptions.has(name) && !signatureQuery.has(name)) throw new StorageProtocolError("NotImplemented", 501)
    if (queryOptions.has(name)) query[name] = value
  }
  const separator = target.path.indexOf("/", 1)
  let bucket: string, key: string
  try {
    bucket = decodeURIComponent(separator < 0 ? target.path.slice(1) : target.path.slice(1, separator))
    key = separator < 0 ? "" : decodeURIComponent(target.path.slice(separator + 1))
  } catch { throw new StorageProtocolError("InvalidRequest", 400) }
  if (bucket && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(bucket))) throw new StorageProtocolError("InvalidRequest", 400)
  if (new TextEncoder().encode(key).byteLength > 1024) throw new StorageProtocolError("InvalidRequest", 400)
  let action: StorageAction
  let allowed: readonly string[] = []
  if (!bucket) {
    if (key || request.method !== "GET") throw new StorageProtocolError("MethodNotAllowed", 405)
    action = "ListBuckets"
  } else if (!key) {
    if (request.method === "HEAD") action = "HeadBucket"
    else if (request.method === "GET" && query.uploads === "") {
      action = "ListMultipartUploads"; allowed = ["uploads", "prefix", "max-uploads", "key-marker", "upload-id-marker"]
      if (query["max-uploads"] !== undefined && (!/^[1-9]\d{0,3}$/.test(query["max-uploads"]) || Number(query["max-uploads"]) > 1000)) throw new StorageProtocolError("InvalidRequest", 400)
    }
    else if (request.method === "GET" && query.location !== undefined) { action = "GetBucketLocation"; allowed = ["location"] }
    else if (request.method === "GET" && query["list-type"] === "2") {
      action = "ListObjectsV2"
      allowed = ["list-type", "prefix", "delimiter", "continuation-token", "max-keys", "start-after", "encoding-type"]
      if (query["max-keys"] !== undefined && (!/^\d{1,4}$/.test(query["max-keys"]) || Number(query["max-keys"]) > 1000)) throw new StorageProtocolError("InvalidRequest", 400)
      if (query["encoding-type"] !== undefined && query["encoding-type"] !== "url") throw new StorageProtocolError("InvalidRequest", 400)
    } else throw new StorageProtocolError("NotImplemented", 501)
  } else if (query.uploadId !== undefined) {
    if (!query.uploadId || query.uploadId.length > 1024) throw new StorageProtocolError("InvalidRequest", 400)
    allowed = ["uploadId"]
    if (request.method === "PUT") {
      action = "UploadPart"
      allowed = ["uploadId", "partNumber"]
      if (!/^[1-9]\d{0,4}$/.test(query.partNumber || "") || Number(query.partNumber) > 10000) throw new StorageProtocolError("InvalidRequest", 400)
    } else if (request.method === "GET") {
      action = "ListParts"
      allowed = ["uploadId", "part-number-marker", "max-parts"]
      for (const name of ["part-number-marker", "max-parts"]) if (query[name] !== undefined && (!/^\d{1,5}$/.test(query[name]!) || Number(query[name]) > (name === "max-parts" ? 1000 : 10000))) throw new StorageProtocolError("InvalidRequest", 400)
    } else if (request.method === "POST") action = "CompleteMultipartUpload"
    else if (request.method === "DELETE") action = "AbortMultipartUpload"
    else throw new StorageProtocolError("MethodNotAllowed", 405)
  } else if (query.uploads !== undefined) {
    if (request.method !== "POST" || query.uploads !== "") throw new StorageProtocolError("InvalidRequest", 400)
    action = "CreateMultipartUpload"
    allowed = ["uploads"]
  } else {
    const actions: Record<string, StorageAction> = { GET: "GetObject", HEAD: "HeadObject", PUT: "PutObject", DELETE: "DeleteObject" }
    const selected = actions[request.method]
    if (!selected) throw new StorageProtocolError("MethodNotAllowed", 405)
    action = selected
  }
  const allowedSet = new Set(allowed)
  if (Object.keys(query).some(name => !allowedSet.has(name))) throw new StorageProtocolError("NotImplemented", 501)
  const range = request.headers.get("range")
  if (range && (action !== "GetObject" || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) throw new StorageProtocolError("NotImplemented", 501)
  if ([...request.headers.keys()].some(name => name.startsWith("x-amz-meta-")) && !["PutObject", "CreateMultipartUpload"].includes(action)) throw new StorageProtocolError("NotImplemented", 501)
  return { action, bucket, key, query, range }
}

function xmlEscape(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;") }

/** Only closed, static messages go on the wire; never echo URLs or errors. */
export function storageErrorResponse(code: "AccessDenied" | "SignatureDoesNotMatch" | "InvalidRequest" | "NotImplemented" | "MethodNotAllowed" | "NoSuchBucket" | "NoSuchKey" | "NoSuchUpload" | "InvalidRange" | "EntityTooLarge" | "IncompleteBody" | "XAmzContentSHA256Mismatch" | "SlowDown" | "InternalError", requestId: string, status: number) {
  const id = /^[a-zA-Z0-9-]{1,128}$/.test(requestId) ? requestId : "unknown"
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(code)}</Message><RequestId>${id}</RequestId></Error>`, { status, headers: { "content-type": "application/xml", "x-amz-request-id": id, "cache-control": "no-store" } })
}
