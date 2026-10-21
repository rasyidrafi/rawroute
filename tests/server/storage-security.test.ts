import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { encryptStorageSecret, decryptStorageSecret, isPublicStorageAddress, resolveStorageEndpoint } from "../../packages/gateway-storage/src/server/security"
import { storageKeyAllows, supportsStorageAction, type StorageConnection, type AttachedBucket, type StorageClientKey } from "../../packages/gateway-storage/src/contracts"

test("storage secrets are recoverable, randomized and bound to their record/workspace", () => {
  const key = randomBytes(32)
  const encrypted = encryptStorageSecret("sensitive-upstream-secret", key, "workspace:connection")
  expect(JSON.stringify(encrypted)).not.toContain("sensitive")
  expect(decryptStorageSecret(encrypted, key, "workspace:connection")).toBe("sensitive-upstream-secret")
  expect(encryptStorageSecret("sensitive-upstream-secret", key, "workspace:connection")).not.toEqual(encrypted)
  expect(() => decryptStorageSecret(encrypted, key, "other:connection")).toThrow("Storage secret could not be decrypted.")
  expect(() => decryptStorageSecret(encrypted, randomBytes(32), "workspace:connection")).toThrow("Storage secret could not be decrypted.")
  expect(() => decryptStorageSecret({ ...encrypted, tag: randomBytes(16).toString("base64") }, key, "workspace:connection")).toThrow("Storage secret could not be decrypted.")
  expect(() => encryptStorageSecret("secret", randomBytes(16), "workspace:connection")).toThrow("Invalid storage encryption input.")
})

test("storage endpoint guard rejects private, metadata, mapped and transition addresses", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "198.18.0.1", "192.0.2.1", "203.0.113.1", "224.0.0.1", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2002:7f00:1::", "2001:db8::1", "64:ff9b::7f00:1"]) expect(isPublicStorageAddress(address)).toBe(false)
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPublicStorageAddress(address)).toBe(true)
  const resolved = await resolveStorageEndpoint("https://objects.example", async () => [{ address: "1.1.1.1", family: 4 }])
  expect(resolved.addresses).toEqual([{ address: "1.1.1.1", family: 4 }])
  await expect(resolveStorageEndpoint("https://objects.example", async () => [{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }])).rejects.toThrow("only to public")
  for (const endpoint of ["http://objects.example", "https://user:secret@objects.example", "https://objects.example/path", "https://objects.example?token=secret", "https://objects.example#fragment", "https://objects.example:9000", "https://127.0.0.1", "https://[::ffff:127.0.0.1]"]) await expect(resolveStorageEndpoint(endpoint)).rejects.toThrow()
  await expect(resolveStorageEndpoint("https://objects.example", async () => [])).rejects.toThrow("only to public")
})

test("bucket policy is deny-by-default and cannot cross workspace or survive revocation", () => {
  const bucket: AttachedBucket = { id: "bucket-1", workspaceId: "workspace-a", connectionId: "connection-1", name: "global-name", upstreamBucket: "real-name" }
  const key: StorageClientKey = { id: "key-1", workspaceId: "workspace-a", accessKeyId: "ACCESSKEY", policy: { bucketIds: [bucket.id], actions: ["GetObject"] } }
  expect(storageKeyAllows(key, bucket, "GetObject")).toBe(true)
  expect(storageKeyAllows(key, bucket, "PutObject")).toBe(false)
  expect(storageKeyAllows(key, { ...bucket, workspaceId: "workspace-b" }, "GetObject")).toBe(false)
  expect(storageKeyAllows(key, { ...bucket, id: "bucket-2" }, "GetObject")).toBe(false)
  expect(storageKeyAllows({ ...key, revokedAt: new Date().toISOString() }, bucket, "GetObject")).toBe(false)
  expect(storageKeyAllows({ ...key, policy: { bucketIds: [], actions: [] } }, bucket, "GetObject")).toBe(false)
})

test("unknown, stale and failed capabilities are not supported", () => {
  const connection: StorageConnection = { id: "connection-1", workspaceId: "workspace-a", revision: 2, endpoint: "https://objects.example", region: "us-east-1", forcePathStyle: true, capabilities: {} }
  expect(supportsStorageAction(connection, "PutObject")).toBe(false)
  for (const status of ["unknown", "failed", "unsupported", "supported"] as const) {
    connection.capabilities.PutObject = { status, connectionRevision: 2, checkedAt: new Date().toISOString(), source: "probe" }
    expect(supportsStorageAction(connection, "PutObject")).toBe(status === "supported")
  }
  connection.revision++
  expect(supportsStorageAction(connection, "PutObject")).toBe(false)
})
