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

function cloneOverride(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneOverride)
  if (isPlainObject(value)) {
    const clone: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) clone[key] = cloneOverride(nested)
    return clone
  }
  return value
}

export function mergeRequestOverrides(payload: Record<string, unknown>, overrides: Record<string, unknown>) {
  if (!Object.keys(overrides).length) return payload
  const merge = (base: unknown, configured: unknown): unknown => {
    if (!isPlainObject(base) || !isPlainObject(configured)) return cloneOverride(configured)
    const result: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(configured)) result[key] = key in result ? merge(result[key], value) : cloneOverride(value)
    return result
  }
  return merge(payload, overrides) as Record<string, unknown>
}
