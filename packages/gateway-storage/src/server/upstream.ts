import { Agent } from "node:https"
import { Agent as HttpAgent } from "node:http"
import { Readable } from "node:stream"
import { NodeHttpHandler } from "@smithy/node-http-handler"
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetBucketLocationCommand, GetObjectCommand, HeadBucketCommand,
  HeadObjectCommand, ListObjectsV2Command, ListPartsCommand, PutObjectCommand,
  S3Client, UploadPartCommand,
} from "@aws-sdk/client-s3"
import type { StorageAction, StorageConnection } from "../contracts"
import { supportsStorageAction } from "../contracts"
import { resolveStorageEndpoint, type StorageResolver } from "./security"
import { storageTrustedOrigins } from "./config"

export class StorageUpstreamError extends Error {
  constructor(readonly code: "NotImplemented" | "NoSuchBucket" | "NoSuchKey" | "NoSuchUpload" | "AccessDenied" | "InvalidRange" | "UpstreamFailure") { super(code) }
}

const publicCodes = new Set(["NoSuchBucket", "NoSuchKey", "NoSuchUpload", "AccessDenied", "InvalidRange"] as const)
function redactUpstreamError(error: unknown): StorageUpstreamError {
  const code = error instanceof Error ? error.name : ""
  return new StorageUpstreamError(publicCodes.has(code as "NoSuchKey") ? code as "NoSuchBucket" | "NoSuchKey" | "NoSuchUpload" | "AccessDenied" | "InvalidRange" : "UpstreamFailure")
}

/** One connection/bucket, no cross-provider fallback and no stream-write retry.
 * SDK serializes/signs native S3 operations. DNS is resolved once and the HTTPS
 * agent is pinned to validated addresses, with normal certificate/SNI checks.
 * Region redirects and SDK retries are deliberately disabled.
 */
export async function createStorageUpstream(options: {
  connection: StorageConnection
  upstreamBucket: string
  credentials: { accessKeyId: string; secretAccessKey: string }
  resolver?: StorageResolver
  maximumSockets?: number
  probe?: boolean
}) {
  const { connection } = options
  if (!connection.forcePathStyle) throw new StorageUpstreamError("NotImplemented")
  const endpoint = await resolveStorageEndpoint(connection.endpoint, options.resolver, storageTrustedOrigins())
  const address = endpoint.addresses[0]!
  const AgentType = endpoint.url.protocol === "https:" ? Agent : HttpAgent
  const agent = new AgentType({
    keepAlive: true,
    maxSockets: options.maximumSockets || 16,
    lookup(hostname, lookupOptions, callback) {
      if (hostname !== endpoint.url.hostname.replace(/^\[|\]$/g, "")) { callback(new Error("Storage endpoint changed."), "", 0); return }
      if (lookupOptions.all) callback(null, [{ address: address.address, family: address.family }])
      else callback(null, address.address, address.family)
    },
  })
  const client = new S3Client({
    endpoint: endpoint.url.origin,
    region: connection.region,
    credentials: options.credentials,
    forcePathStyle: true,
    maxAttempts: 1,
    followRegionRedirects: false,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: new NodeHttpHandler({ ...(endpoint.url.protocol === "https:" ? { httpsAgent: agent } : { httpAgent: agent }), connectionTimeout: 10_000, requestTimeout: 300_000, throwOnRequestTimeout: true }),
  })
  const Bucket = options.upstreamBucket
  const run = async <T>(action: StorageAction, operation: () => Promise<T>): Promise<T> => {
    if (!options.probe && !supportsStorageAction(connection, action)) throw new StorageUpstreamError("NotImplemented")
    try { return await operation() } catch (error) { throw redactUpstreamError(error) }
  }
  const body = (source: ReadableStream<Uint8Array>) => Readable.from((async function* () {
    const reader = source.getReader()
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) return
        yield result.value
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  })())
  const streamWrite = async <T>(action: StorageAction, source: ReadableStream<Uint8Array>, signal: AbortSignal | undefined, operation: (stream: Readable, signal: AbortSignal) => Promise<T>): Promise<T> => {
    const cancellation = new AbortController()
    const combined = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal
    const stream = body(source)
    // NodeHttpHandler pipes a Readable but does not forward source errors to
    // the HTTP request. Abort explicitly, and always handle the error event.
    stream.on("error", () => cancellation.abort())
    try { return await run(action, () => operation(stream, combined)) } finally { stream.destroy() }
  }
  return {
    close() { client.destroy(); agent.destroy() },
    headBucket: (signal?: AbortSignal) => run("HeadBucket", () => client.send(new HeadBucketCommand({ Bucket }), { abortSignal: signal })),
    getBucketLocation: (signal?: AbortSignal) => run("GetBucketLocation", () => client.send(new GetBucketLocationCommand({ Bucket }), { abortSignal: signal })),
    listObjects: (input: { Prefix?: string; Delimiter?: string; ContinuationToken?: string; MaxKeys?: number; StartAfter?: string; EncodingType?: "url" }, signal?: AbortSignal) => run("ListObjectsV2", () => client.send(new ListObjectsV2Command({ ...input, Bucket }), { abortSignal: signal })),
    headObject: (Key: string, signal?: AbortSignal) => run("HeadObject", () => client.send(new HeadObjectCommand({ Bucket, Key }), { abortSignal: signal })),
    getObject: (Key: string, Range?: string, signal?: AbortSignal) => run("GetObject", () => client.send(new GetObjectCommand({ Bucket, Key, Range }), { abortSignal: signal })),
    putObject: (input: { Key: string; Body: ReadableStream<Uint8Array>; ContentLength: number; ContentType?: string; Metadata?: Record<string, string> }, signal?: AbortSignal) => streamWrite("PutObject", input.Body, signal, (Body, abortSignal) => client.send(new PutObjectCommand({ ...input, Bucket, Body }), { abortSignal })),
    deleteObject: (Key: string, signal?: AbortSignal) => run("DeleteObject", () => client.send(new DeleteObjectCommand({ Bucket, Key }), { abortSignal: signal })),
    createMultipart: (input: { Key: string; ContentType?: string; Metadata?: Record<string, string> }, signal?: AbortSignal) => run("CreateMultipartUpload", () => client.send(new CreateMultipartUploadCommand({ ...input, Bucket }), { abortSignal: signal })),
    uploadPart: (input: { Key: string; UploadId: string; PartNumber: number; ContentLength: number; Body: ReadableStream<Uint8Array> }, signal?: AbortSignal) => streamWrite("UploadPart", input.Body, signal, (Body, abortSignal) => client.send(new UploadPartCommand({ ...input, Bucket, Body }), { abortSignal })),
    listParts: (input: { Key: string; UploadId: string; PartNumberMarker?: string; MaxParts?: number }, signal?: AbortSignal) => run("ListParts", () => client.send(new ListPartsCommand({ ...input, Bucket }), { abortSignal: signal })),
    completeMultipart: (input: { Key: string; UploadId: string; Parts: { ETag: string; PartNumber: number }[] }, signal?: AbortSignal) => run("CompleteMultipartUpload", () => client.send(new CompleteMultipartUploadCommand({ Bucket, Key: input.Key, UploadId: input.UploadId, MultipartUpload: { Parts: input.Parts } }), { abortSignal: signal })),
    abortMultipart: (input: { Key: string; UploadId: string }, signal?: AbortSignal) => run("AbortMultipartUpload", () => client.send(new AbortMultipartUploadCommand({ ...input, Bucket }), { abortSignal: signal })),
  }
}
