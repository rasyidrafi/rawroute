const maximumOverrideBytes = 16 * 1024
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateKeys(value: unknown) {
  if (Array.isArray(value)) { value.forEach(validateKeys); return }
  if (!isPlainObject(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new Error(`Request override key ${key} is not allowed.`)
    validateKeys(nested)
  }
}

export function validateRequestOverrides(value: unknown) {
  if (!isPlainObject(value)) throw new Error("Request body overrides must be a JSON object.")
  if (Object.hasOwn(value, "model")) throw new Error("Request body overrides cannot replace the model field.")
  validateKeys(value)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumOverrideBytes) {
    throw new Error("Request body overrides must be 16 KiB or smaller.")
  }
  return value
}

export function mergeRequestOverrides(payload: Record<string, unknown>, overrides: Record<string, unknown>) {
  const merge = (base: unknown, configured: unknown): unknown => {
    if (!isPlainObject(base) || !isPlainObject(configured)) return structuredClone(configured)
    const result: Record<string, unknown> = structuredClone(base)
    for (const [key, value] of Object.entries(configured)) result[key] = key in result ? merge(result[key], value) : structuredClone(value)
    return result
  }
  return merge(payload, overrides) as Record<string, unknown>
}
