import { normalizeReasoningEffort } from "@/lib/request-normalization"

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nestedValue(payload: Record<string, unknown>, path: string[]) {
  let current: unknown = payload
  for (const key of path) {
    current = objectValue(current)?.[key]
    if (current === undefined) return undefined
  }
  return current
}

const effortPaths = [
  ["reasoning", "effort"],
  ["reasoning_effort"],
  ["output_config", "effort"],
  ["thinking", "effort"],
  ["thinking_config", "thinking_level"],
  ["google", "thinking_config", "thinking_level"],
  ["extra_body", "google", "thinking_config", "thinking_level"],
  ["generationConfig", "thinkingConfig", "thinkingLevel"],
] as const

export function extractReasoningEffort(payload: Record<string, unknown>) {
  const found = effortPaths.flatMap((path) => {
    const effort = normalizeReasoningEffort(nestedValue(payload, [...path]))
    return effort ? [{ path: path.join("."), effort }] : []
  })
  if (!found.length) return undefined

  const unique = new Set(found.map(({ effort }) => effort))
  if (unique.size === 1) {
    return found[0].effort
  }
  return found.map(({ path, effort }) => `${path}:${effort}`).join(", ")
}
