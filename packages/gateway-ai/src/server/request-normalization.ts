const responseTokenLimitAliases = ["max_completion_tokens", "max_tokens"] as const
const responseCompatibilityFields = [...responseTokenLimitAliases, "reasoning_effort"] as const

export function normalizeReasoningEffort(value: unknown) {
  if (typeof value !== "string") return undefined
  const effort = value.trim()
  return effort.length > 0 && effort.length <= 64 ? effort : undefined
}

/**
 * Keep the gateway compatible with clients that send Chat Completions
 * parameter names to a Responses endpoint. CLIProxy owns provider-specific
 * translation; this only converts the public API spelling into the canonical
 * Responses spelling before forwarding the request.
 */
export function normalizeResponsesRequest(payload: Record<string, unknown>, options: { dropOutputTokenLimit?: boolean } = {}) {
  const normalized = { ...payload }
  if (!Object.hasOwn(normalized, "max_output_tokens")) {
    for (const alias of responseTokenLimitAliases) {
      if (Object.hasOwn(normalized, alias)) {
        normalized.max_output_tokens = normalized[alias]
        break
      }
    }
  }
  if (!Object.hasOwn(normalized, "reasoning")) {
    const effort = normalizeReasoningEffort(normalized.reasoning_effort)
    if (effort) normalized.reasoning = { effort }
  }
  for (const field of responseCompatibilityFields) delete normalized[field]
  if (options.dropOutputTokenLimit) delete normalized.max_output_tokens
  return normalized
}
