import { standardReasoningEfforts } from "./combo-reasoning"
import type { Protocol, ReasoningEffort } from "./types"

export type RequestLogMetadata = {
  reasoningEffort?: ReasoningEffort
  toolCount?: number
}

const supportedEfforts = new Set<string>(standardReasoningEfforts)

const reasoningEffortPaths: Record<Protocol, readonly (readonly string[])[]> = {
  "openai-responses": [["reasoning", "effort"], ["reasoning_effort"]],
  "openai-chat": [
    ["reasoning_effort"], ["reasoning", "effort"], ["output_config", "effort"], ["thinking", "effort"],
    ["thinking_config", "thinking_level"], ["google", "thinking_config", "thinking_level"],
    ["extra_body", "google", "thinking_config", "thinking_level"], ["generationConfig", "thinkingConfig", "thinkingLevel"],
  ],
  "anthropic-messages": [
    ["output_config", "effort"], ["thinking", "effort"], ["thinking_config", "thinking_level"],
    ["reasoning", "effort"], ["reasoning_effort"], ["google", "thinking_config", "thinking_level"],
    ["extra_body", "google", "thinking_config", "thinking_level"], ["generationConfig", "thinkingConfig", "thinkingLevel"],
  ],
}

/** Normalize to the reviewed effort vocabulary; custom and arbitrary values are never recorded. */
export function normalizeRequestReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  return supportedEfforts.has(normalized) ? normalized as ReasoningEffort : undefined
}

export function normalizeRequestToolCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Validate stored metadata again at public/API projection boundaries. */
export function normalizeRequestLogMetadata(value: { reasoningEffort?: unknown; toolCount?: unknown }): RequestLogMetadata {
  const reasoningEffort = normalizeRequestReasoningEffort(value.reasoningEffort)
  const toolCount = normalizeRequestToolCount(value.toolCount)
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
  }
}

function pathValue(payload: Record<string, unknown>, path: readonly string[]) {
  let current: unknown = payload
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, key)) return { present: false, value: undefined }
    current = (current as Record<string, unknown>)[key]
  }
  return { present: true, value: current }
}

/**
 * Paths are ordered from protocol-canonical to compatibility spellings. Repeated
 * aliases are accepted only when they agree; invalid or conflicting values are omitted.
 */
export function extractRequestReasoningEffort(payload: Record<string, unknown>, protocol: Protocol): ReasoningEffort | undefined {
  let selected: ReasoningEffort | undefined
  for (const path of reasoningEffortPaths[protocol]) {
    const candidate = pathValue(payload, path)
    if (!candidate.present) continue
    const effort = normalizeRequestReasoningEffort(candidate.value)
    if (!effort || selected !== undefined && effort !== selected) return undefined
    selected = effort
  }
  return selected
}
