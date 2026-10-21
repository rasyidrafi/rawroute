import { timingSafeEqual } from "node:crypto"
import { Sha256 } from "@aws-crypto/sha256-js"
import { HttpRequest } from "@smithy/protocol-http"
import { getCanonicalHeaders, SignatureV4 } from "@smithy/signature-v4"

const algorithm = "AWS4-HMAC-SHA256"
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
export class StorageSignatureError extends Error {
  constructor() { super("The request signature could not be verified.") }
}
export interface StorageSigningCredential {
  accessKeyId: string
  secretAccessKey: string
  keyId: string
  workspaceId: string
  revoked: boolean
}
export interface VerifiedStorageSignature {
  workspaceId: string
  keyId: string
  payloadHash: string
  presigned: boolean
}

/** Smithy owns all canonicalization, SHA-256, HMAC and signing-key derivation.
 * This narrow adapter supplies the signed header allowlist and validates the
 * authentication envelope, scope, lifetime and credential revocation.
 */
class StorageVerifier extends SignatureV4 {
  async expectedSignature(request: HttpRequest, headers: Set<string>, payloadHash: string, date: string, scope: string, signingDate: Date) {
    const canonical = getCanonicalHeaders(request, new Set(Object.keys(request.headers).filter(header => !headers.has(header))), headers)
    if (Object.keys(canonical).sort().join(";") !== [...headers].join(";")) throw new StorageSignatureError()
    const stringToSign = await this.createStringToSign(date, scope, this.createCanonicalRequest(request, canonical, payloadHash), algorithm)
    return this.sign(stringToSign, { signingDate })
  }
}

/** Never use new URL(...).pathname for an S3 object path: WHATWG normalizes
 * dot segments. Use the HTTP parser's original target, not Bun.serve's URL.
 */
export function parseStorageRequestTarget(input: string) {
  const match = /^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?$/.exec(input)
  if (!match || match[1]!.includes("@")) throw new StorageSignatureError()
  const path = match[2] || "/"
  if (path.length > 16_384 || /%(?![0-9a-f]{2})/i.test(path)) throw new StorageSignatureError()
  const query: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>
  if ((match[3]?.length || 0) > 16_384) throw new StorageSignatureError()
  try {
    for (const pair of match[3]?.split("&") || []) {
      if (!pair) continue
      const separator = pair.indexOf("=")
      const key = decodeURIComponent((separator < 0 ? pair : pair.slice(0, separator)).replaceAll("+", " "))
      const value = decodeURIComponent((separator < 0 ? "" : pair.slice(separator + 1)).replaceAll("+", " "))
      const previous = query[key]
      query[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value]
    }
  } catch { throw new StorageSignatureError() }
  return { path, query }
}

function one(query: Record<string, string | string[]>, name: string): string | undefined {
  const value = query[name]
  if (Array.isArray(value)) throw new StorageSignatureError()
  return value
}

function parseDate(value: string) {
  if (!/^\d{8}T\d{6}Z$/.test(value)) throw new StorageSignatureError()
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace(/[-:]/g, "").replace(".000", "") !== value) throw new StorageSignatureError()
  return date
}

export async function verifyStorageSignature(
  request: Request,
  options: { region: string; lookup: (accessKeyId: string) => Promise<StorageSigningCredential | undefined>; now?: Date; rawUrl?: string },
): Promise<VerifiedStorageSignature> {
  try {
    const target = parseStorageRequestTarget(options.rawUrl || request.url)
    const presigned = one(target.query, "X-Amz-Algorithm") !== undefined
    const authorization = request.headers.get("authorization")
    if (presigned && authorization) throw new StorageSignatureError()
    let credential: string, signedHeaders: string, signature: string, timestamp: string
    if (presigned) {
      if (!["GET", "PUT"].includes(request.method) || one(target.query, "X-Amz-Algorithm") !== algorithm) throw new StorageSignatureError()
      credential = one(target.query, "X-Amz-Credential") || ""
      signedHeaders = one(target.query, "X-Amz-SignedHeaders") || ""
      signature = one(target.query, "X-Amz-Signature") || ""
      timestamp = one(target.query, "X-Amz-Date") || ""
    } else {
      const match = /^AWS4-HMAC-SHA256 Credential=([^, ]+),\s*SignedHeaders=([^, ]+),\s*Signature=([0-9a-f]{64})$/.exec(authorization || "")
      if (!match) throw new StorageSignatureError()
      credential = match[1]!
      signedHeaders = match[2]!
      signature = match[3]!
      timestamp = request.headers.get("x-amz-date") || ""
    }
    if (!/^[0-9a-f]{64}$/.test(signature) || one(target.query, "X-Amz-Security-Token") || request.headers.has("x-amz-security-token")) throw new StorageSignatureError()
    const scope = credential.split("/")
    if (scope.length !== 5 || !/^[A-Za-z0-9]{16,128}$/.test(scope[0]!) || scope[1] !== timestamp.slice(0, 8) || scope[2] !== options.region || scope[3] !== "s3" || scope[4] !== "aws4_request") throw new StorageSignatureError()
    const date = parseDate(timestamp)
    const age = (options.now || new Date()).getTime() - date.getTime()
    if (presigned) {
      const expires = one(target.query, "X-Amz-Expires") || ""
      if (!/^[1-9]\d{0,5}$/.test(expires) || Number(expires) > 604800 || age < -900_000 || age > Number(expires) * 1000) throw new StorageSignatureError()
    } else if (Math.abs(age) > 900_000) throw new StorageSignatureError()
    const headerNames = signedHeaders.split(";")
    const headerSet = new Set(headerNames)
    if (headerNames.length > 64 || !headerNames.every(name => /^[a-z0-9-]+$/.test(name)) || [...new Set(headerNames)].sort().join(";") !== signedHeaders || !headerNames.includes("host") || !presigned && !headerNames.includes("x-amz-date")) throw new StorageSignatureError()
    const headers: Record<string, string> = {}
    for (const name of headerNames) {
      const value = request.headers.get(name)
      if (value === null) throw new StorageSignatureError()
      headers[name] = value
    }
    // Every semantic x-amz header must be signed. Content SHA256 is part of the
    // canonical payload line even when not in SignedHeaders (valid S3 behavior).
    for (const [name] of request.headers) if (name.startsWith("x-amz-") && name !== "x-amz-content-sha256" && !headerSet.has(name)) throw new StorageSignatureError()
    const payloadHash = request.headers.get("x-amz-content-sha256") || one(target.query, "X-Amz-Content-Sha256") || (presigned ? "UNSIGNED-PAYLOAD" : emptyHash)
    if (payloadHash !== "UNSIGNED-PAYLOAD" && !/^[0-9a-f]{64}$/.test(payloadHash)) throw new StorageSignatureError()
    const resolved = await options.lookup(scope[0]!)
    if (!resolved || resolved.revoked || resolved.accessKeyId !== scope[0] || !resolved.workspaceId || !resolved.keyId) throw new StorageSignatureError()
    const verifier = new StorageVerifier({ credentials: resolved, region: options.region, service: "s3", sha256: Sha256, uriEscapePath: false, applyChecksum: false })
    const smithyRequest = new HttpRequest({ method: request.method, hostname: headers.host!, path: target.path, query: target.query, headers })
    const expected = await verifier.expectedSignature(smithyRequest, new Set(headerNames), payloadHash, timestamp, scope.slice(1).join("/"), date)
    if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) throw new StorageSignatureError()
    return { workspaceId: resolved.workspaceId, keyId: resolved.keyId, payloadHash, presigned }
  } catch { throw new StorageSignatureError() }
}
