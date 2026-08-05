const reservedHeaders = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
])

const validationCache = new Map<string, Record<string, string>>()
const objectValidationCache = new WeakMap<object, Record<string, string>>()

export function validateProviderHeaders(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Provider headers must be a JSON object.")
  }

  const objectCached = objectValidationCache.get(input)
  if (objectCached) return objectCached
  const cacheKey = JSON.stringify(input)
  const cached = validationCache.get(cacheKey)
  if (cached) {
    objectValidationCache.set(input, cached)
    return cached
  }
  const validated: Record<string, string> = {}
  const probe = new Headers()
  for (const [name, value] of Object.entries(input)) {
    const normalized = name.toLowerCase()
    if (reservedHeaders.has(normalized)) throw new Error(`Provider header ${name} is reserved.`)
    if (typeof value !== "string") throw new Error(`Provider header ${name} must be a string.`)
    try {
      probe.set(name, value)
    } catch {
      throw new Error(`Invalid provider header name or value: ${name}`)
    }
    validated[name] = value
  }
  if (validationCache.size >= 128) validationCache.delete(validationCache.keys().next().value as string)
  validationCache.set(cacheKey, validated)
  objectValidationCache.set(input, validated)
  return validated
}
