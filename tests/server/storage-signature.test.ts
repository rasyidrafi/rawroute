import { expect, test } from "bun:test"
import { Sha256 } from "@aws-crypto/sha256-js"
import { HttpRequest } from "@smithy/protocol-http"
import { SignatureV4 } from "@smithy/signature-v4"
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { connect } from "node:net"
import { createServer } from "node:http"
import { parseStorageRequestTarget, verifyStorageSignature, type StorageSigningCredential } from "../../packages/gateway-storage/src/server/signature"
import botocoreSignatures from "../fixtures/storage-botocore-signatures.json"

const credentials: StorageSigningCredential = { accessKeyId: "RAWROUTETESTKEY00001", secretAccessKey: "this-is-not-a-real-secret", workspaceId: "workspace-a", keyId: "key-a", revoked: false }
const date = new Date("2026-10-21T12:00:00Z")
const options = { region: "us-east-1", lookup: async () => credentials, now: date }

test("independently generated Python botocore S3 header and presigned fixtures verify", async () => {
  for (const fixture of botocoreSignatures.cases) {
    const request = new Request(fixture.url, { method: fixture.method, headers: Object.fromEntries(Object.entries(fixture.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")), body: fixture.body })
    expect((await verifyStorageSignature(request, { ...options, rawUrl: fixture.url })).workspaceId).toBe("workspace-a")
    await expect(verifyStorageSignature(request, options)).rejects.toThrow()
  }
})

async function signedRequest(path = "/bucket/key%2Fwith%20space", body?: string) {
  const signer = new SignatureV4({ credentials, region: "us-east-1", service: "s3", sha256: Sha256, uriEscapePath: false })
  const signed = await signer.sign(new HttpRequest({ hostname: "storage.example", method: body ? "PUT" : "GET", path, headers: { host: "storage.example" }, body }), { signingDate: date })
  return new Request(`https://storage.example${path}`, { method: signed.method, headers: signed.headers, body })
}

test("SigV4 verifies header authentication and returns identity only after verification", async () => {
  const request = await signedRequest()
  expect(await verifyStorageSignature(request, options)).toEqual({ workspaceId: "workspace-a", keyId: "key-a", payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", presigned: false })
  const put = await signedRequest("/bucket/key", "hello")
  expect((await verifyStorageSignature(put, options)).payloadHash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
  await expect(verifyStorageSignature(new Request("https://storage.example/bucket/other", request), options)).rejects.toThrow("could not be verified")
  await expect(verifyStorageSignature(request, { ...options, region: "eu-west-1" })).rejects.toThrow()
  await expect(verifyStorageSignature(request, { ...options, lookup: async () => undefined })).rejects.toThrow()
  await expect(verifyStorageSignature(request, { ...options, lookup: async () => ({ ...credentials, revoked: true }) })).rejects.toThrow()
  await expect(verifyStorageSignature(request, { ...options, now: new Date(date.getTime() + 901_000) })).rejects.toThrow()
  const unsignedAmzHeader = new Request(request)
  unsignedAmzHeader.headers.set("x-amz-meta-injected", "unsafe")
  await expect(verifyStorageSignature(unsignedAmzHeader, options)).rejects.toThrow()
})

test("AWS SDK v3 presigned GET/PUT verify including encoded key and signed query", async () => {
  const client = new S3Client({ credentials, region: "us-east-1", endpoint: "https://storage.example", forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED" })
  try {
    for (const method of ["GET", "PUT"]) {
      const input = { Bucket: "logical-bucket", Key: "folder/plus+percent% space/日本語" }
      const command = method === "GET" ? new GetObjectCommand(input) : new PutObjectCommand(input)
      const url = await getSignedUrl(client, command, { signingDate: date, expiresIn: 60 })
      const request = new Request(url, { method, headers: { host: "storage.example" } })
      expect(await verifyStorageSignature(request, options)).toEqual({ workspaceId: "workspace-a", keyId: "key-a", payloadHash: "UNSIGNED-PAYLOAD", presigned: true })
      await expect(verifyStorageSignature(request, { ...options, now: new Date(date.getTime() + 61_000) })).rejects.toThrow()
      await expect(verifyStorageSignature(new Request(`${url}&prefix=injected`, request), options)).rejects.toThrow()
      await expect(verifyStorageSignature(new Request(`${url}&X-Amz-Expires=3600`, request), options)).rejects.toThrow()
    }
  } finally { client.destroy() }
})

test("raw target parser preserves object path and repeated/empty query values", () => {
  expect(parseStorageRequestTarget("https://storage.example/bucket/a/../b//%2e/%2F?prefix=a%2Bb&prefix=a+b&uploads")).toEqual({ path: "/bucket/a/../b//%2e/%2F", query: { prefix: ["a+b", "a b"], uploads: "" } })
  expect(() => parseStorageRequestTarget("https://storage.example/bucket/%GG")).toThrow()
  expect(() => parseStorageRequestTarget("https://storage.example/bucket/key?prefix=%FF")).toThrow()
})

test("Bun.serve normalizes S3 dot segments: it cannot be used as the S3 transport", async () => {
  const observed: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    observed.push(request.url)
    return new Response("ok", { headers: { connection: "close" } })
  } })
  try {
    for (const [target, normalized] of [["/bucket/a/../b//%2e/%2F?prefix=a%2Bb&prefix=a+b&uploads", "/bucket/b//%2F?prefix=a%2Bb&prefix=a+b&uploads"], ["/bucket/%25%2f%2F+space%20?x=%2f&x=&empty", "/bucket/%25%2f%2F+space%20?x=%2f&x=&empty"]]) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: server.port! }, () => {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: storage.example\r\nConnection: close\r\n\r\n`)
        })
        socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error("Native S3 target spike timed out")) })
        socket.on("data", () => undefined)
        socket.on("error", reject)
        socket.on("end", resolve)
      })
      expect(observed.at(-1)).toBe(`http://storage.example${normalized}`)
    }
  } finally { await server.stop(true) }
})

test("Bun node:http transport preserves exact raw targets needed for S3 verification", async () => {
  const observed: string[] = []
  const server = createServer((request, response) => {
    observed.push(request.url || "")
    response.setHeader("connection", "close")
    response.end("ok")
  })
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve) })
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Unexpected spike listener address")
    const target = "/bucket/a/../b//%2e/%2F?prefix=a%2Bb&prefix=a+b&uploads"
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: address.port }, () => socket.write(`GET ${target} HTTP/1.1\r\nHost: storage.example\r\nConnection: close\r\n\r\n`))
      socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error("S3 transport spike timed out")) })
      socket.on("data", () => undefined)
      socket.on("error", reject)
      socket.on("end", resolve)
    })
    expect(observed).toEqual([target])
    const rawUrl = "https://storage.example/bucket/a/../b//%2e/%2F"
    const request = await signedRequest("/bucket/a/../b//%2e/%2F")
    await expect(verifyStorageSignature(request, options)).rejects.toThrow()
    expect((await verifyStorageSignature(request, { ...options, rawUrl })).workspaceId).toBe("workspace-a")
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
  }
})
