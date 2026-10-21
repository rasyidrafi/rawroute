import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { isIP } from "node:net"
import { lookup } from "node:dns/promises"
import ipaddr from "ipaddr.js"

export interface EncryptedStorageSecret {
  version: 1
  nonce: string
  ciphertext: string
  tag: string
}

/** Context binding prevents moving encrypted credentials across owners/records. */
export function encryptStorageSecret(secret: string, key: Uint8Array, context: string): EncryptedStorageSecret {
  if (key.byteLength !== 32 || !context || !secret) throw new Error("Invalid storage encryption input.")
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from(`rawroute:storage:v1:${context}`))
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()])
  return { version: 1, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") }
}

export function decryptStorageSecret(value: EncryptedStorageSecret, key: Uint8Array, context: string): string {
  try {
    if (key.byteLength !== 32 || value.version !== 1 || !context) throw new Error("Invalid secret")
    const nonce = Buffer.from(value.nonce, "base64")
    const tag = Buffer.from(value.tag, "base64")
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) throw new Error("Invalid secret")
    const decipher = createDecipheriv("aes-256-gcm", key, nonce)
    decipher.setAAD(Buffer.from(`rawroute:storage:v1:${context}`))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8")
  } catch {
    // Never echo ciphertext, contexts, keys or underlying crypto exceptions.
    throw new Error("Storage secret could not be decrypted.")
  }
}

/** Conservative public-unicast policy, including IPv4 embedded in IPv6. */
export function isPublicStorageAddress(address: string): boolean {
  if (!isIP(address)) return false
  const parsed = ipaddr.parse(address)
  if (parsed.kind() === "ipv6") {
    // Only 2000::/3 global unicast. Reject transition mechanisms rather than
    // attempting to route their embedded IPv4 addresses safely.
    if ((parsed.toByteArray()[0]! & 0xe0) !== 0x20) return false
  }
  return parsed.range() === "unicast"
}

export type StorageResolver = (hostname: string) => Promise<readonly { address: string; family: number }[]>

/** Validation alone is not DNS-rebinding protection: callers MUST pin one of
 * these addresses in their transport lookup and reject redirects. The hostname
 * remains unchanged for TLS SNI and signing. Never feed just `url` to fetch.
 */
export async function resolveStorageEndpoint(input: string, resolve: StorageResolver = hostname => lookup(hostname, { all: true, verbatim: true }), trustedOrigins: readonly string[] = []) {
  let url: URL
  try { url = new URL(input) } catch { throw new Error("Invalid storage endpoint.") }
  const trusted = trustedOrigins.includes(url.origin)
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== "/" || !trusted && (url.protocol !== "https:" || url.port && url.port !== "443")) throw new Error("Storage endpoint must be an HTTPS origin on port 443 or a deployment-allowlisted origin.")
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  let addresses: readonly { address: string; family: number }[]
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname) } catch { throw new Error("Storage endpoint could not be resolved.") }
  if (!addresses.length || addresses.some(entry => !isIP(entry.address) || !trusted && !isPublicStorageAddress(entry.address) || entry.family !== isIP(entry.address))) throw new Error("Storage endpoint must resolve only to public addresses.")
  return { url, addresses: addresses.map(entry => ({ ...entry })) }
}
