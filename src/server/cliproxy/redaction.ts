import { cliproxySecret } from "./connection"

export function redactText(value: string) {
  for (const kind of ["apiKey", "managementKey"] as const) {
    try { const secret = cliproxySecret(kind); if (secret) value = value.replaceAll(secret, "[REDACTED]") } catch { /* unavailable instance */ }
  }
  return value
    .replace(/((?:\\?["'])?(?:(?:access|refresh|id)[_-]?token|api[_-]?key|secret|password)(?:\\?["'])?\s*[:=]\s*)(?:\\?["'])?(?:\\.|[^\s,;}])+/gi, "$1[REDACTED]")
    .replace(/\b(?:bearer|basic)\s+[\w.~+/=-]+/gi, "[REDACTED]")
    .replace(/(?:[?&]|%3[fF]|%26)(?:token|code|access(?:_|%5[fF])token|refresh(?:_|%5[fF])token|api(?:_|%5[fF]|-)key)=[^&#\s]+/gi, "[REDACTED]")
}

export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value)
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(token|secret|password|authorization|api[_-]?key|body|prompt)/i.test(key)).map(([key, item]) => [key, redact(item)]))
}
