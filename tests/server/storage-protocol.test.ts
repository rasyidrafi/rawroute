import { expect, test } from "bun:test"
import { classifyStorageRequest, storageErrorResponse } from "../../packages/gateway-storage/src/server/protocol"
import { createStorageUpstream } from "../../packages/gateway-storage/src/server/upstream"

const classify = (path: string, method = "GET", headers?: HeadersInit) => classifyStorageRequest(new Request(`https://storage.example${path}`, { method, headers }))

test("closed S3 classifier recognizes core and multipart operations without changing object keys", () => {
  expect(classify("/").action).toBe("ListBuckets")
  expect(classify("/bucket", "HEAD").action).toBe("HeadBucket")
  expect(classify("/bucket?location").action).toBe("GetBucketLocation")
  expect(classify("/bucket?list-type=2&prefix=a%2Fb&max-keys=10").action).toBe("ListObjectsV2")
  for (const [method, action] of [["PUT", "PutObject"], ["GET", "GetObject"], ["HEAD", "HeadObject"], ["DELETE", "DeleteObject"]] as const) {
    const result = classify("/bucket/folder//percent%25%2B+%20日本語", method)
    expect(result.action).toBe(action)
    expect(result.key).toBe("folder//percent%++ 日本語")
  }
  expect(classify("/bucket/key?uploads", "POST").action).toBe("CreateMultipartUpload")
  expect(classify("/bucket/key?uploadId=opaque&partNumber=1", "PUT").action).toBe("UploadPart")
  expect(classify("/bucket/key?uploadId=opaque&max-parts=1000").action).toBe("ListParts")
  expect(classify("/bucket/key?uploadId=opaque", "POST").action).toBe("CompleteMultipartUpload")
  expect(classify("/bucket/key?uploadId=opaque", "DELETE").action).toBe("AbortMultipartUpload")
  expect(classify("/bucket/key", "GET", { range: "bytes=1-4" }).range).toBe("bytes=1-4")
})

test("unsupported S3 options fail closed, including checksums, tags, copy and multipart ambiguity", () => {
  for (const path of ["/bucket/key?tagging", "/bucket/key?versionId=old", "/bucket/key?response-content-type=text/plain", "/bucket?list-type=1", "/bucket?list-type=2&fetch-owner=true", "/bucket?list-type=2&max-keys=1001", "/bucket?list-type=2&max-keys=-1", "/bucket/key?uploadId=u&uploads", "/bucket/key?uploadId=u&partNumber=0", "/bucket/key?uploadId=u&partNumber=10001"]) expect(() => classify(path, path.includes("partNumber") ? "PUT" : "GET")).toThrow()
  const unsupportedHeaders: Record<string, string>[] = [{ "x-amz-tagging": "tag=value" }, { "x-amz-checksum-sha256": "checksum" }, { "x-amz-copy-source": "/other/key" }, { "x-amz-acl": "public-read" }, { "x-amz-object-lock-mode": "COMPLIANCE" }, { "content-md5": "hash" }, { "content-encoding": "aws-chunked" }, { "if-match": "etag" }]
  for (const headers of unsupportedHeaders) expect(() => classify("/bucket/key", "PUT", headers)).toThrow("NotImplemented")
  expect(() => classify("/bucket/key", "GET", { range: "bytes=1-2,4-5" })).toThrow("NotImplemented")
  expect(() => classify("/bucket", "PUT")).toThrow("NotImplemented")
  expect(() => classify("/bucket/key?uploadId=u&uploadId=v")).toThrow("InvalidRequest")
})

test("S3 XML errors never reflect unsafe request ids or arbitrary error text", async () => {
  const response = storageErrorResponse("AccessDenied", "<secret-url>", 403)
  expect(response.status).toBe(403)
  expect(response.headers.get("content-type")).toBe("application/xml")
  expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>AccessDenied</Message><RequestId>unknown</RequestId></Error>')
})

test("native SDK upstream does not attempt network for unknown capability evidence", async () => {
  const upstream = await createStorageUpstream({ connection: { id: "c", workspaceId: "w", revision: 1, endpoint: "https://objects.example", region: "us-east-1", forcePathStyle: true, capabilities: {} }, upstreamBucket: "attached-bucket", credentials: { accessKeyId: "disposable", secretAccessKey: "disposable" }, resolver: async () => [{ address: "1.1.1.1", family: 4 }] })
  try {
    await expect(upstream.putObject({ Key: "key", Body: new ReadableStream(), ContentLength: 0 })).rejects.toThrow("NotImplemented")
    await expect(upstream.getObject("key")).rejects.toThrow("NotImplemented")
  } finally { upstream.close() }
})
