import { afterEach, describe, expect, test } from "vitest"

import { decryptCredentialSecret, encryptCredentialSecret } from "@/lib/credential-secrets"

const previous = process.env.CREDENTIAL_ENCRYPTION_KEY

afterEach(() => {
  if (previous === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY
  else process.env.CREDENTIAL_ENCRYPTION_KEY = previous
})

describe("credential secrets", () => {
  test("encrypts and decrypts OAuth secrets without deterministic ciphertext", () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = "test-encryption-key"
    const first = encryptCredentialSecret("refresh-token")
    const second = encryptCredentialSecret("refresh-token")
    expect(first?.startsWith("rr1:")).toBe(true)
    expect(second?.startsWith("rr1:")).toBe(true)
    expect(first).not.toBe(second)
    expect(decryptCredentialSecret(first)).toBe("refresh-token")
    expect(decryptCredentialSecret("legacy-value")).toBe("legacy-value")
  })
})
