import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

const prefix = "rr1:"

function secretKey() {
  const configured = process.env.CREDENTIAL_ENCRYPTION_KEY || process.env.SESSION_SECRET
  if (!configured) throw new Error("CREDENTIAL_ENCRYPTION_KEY or SESSION_SECRET is required to protect OAuth credentials.")
  return createHash("sha256").update(configured).digest()
}

export function encryptCredentialSecret(value: string | undefined) {
  if (!value) return value
  if (value.startsWith(prefix)) return value
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${prefix}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`
}

export function decryptCredentialSecret(value: string | undefined) {
  if (!value || !value.startsWith(prefix)) return value
  const [ivText, tagText, ciphertextText] = value.slice(prefix.length).split(".")
  if (!ivText || !tagText || !ciphertextText) throw new Error("Stored credential secret is malformed.")
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivText, "base64url"))
  decipher.setAuthTag(Buffer.from(tagText, "base64url"))
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8")
}

