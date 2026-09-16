import type { ComboMember, Model, ModelCombo, Protocol } from "@/lib/types"

export const standardReasoningEfforts = ["none", "auto", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export const comboCustomPayloadMaxBytes = 16 * 1024
export const comboCustomPayloadMaxDepth = 12
export const protectedComboPayloadFields = ["model", "messages", "input", "prompt", "stream", "stream_options"] as const

const protectedFields = new Set<string>(protectedComboPayloadFields)
const unsafeFields = new Set(["__proto__", "prototype", "constructor"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateCustomValue(value: unknown, path: string[], depth: number) {
  if (depth > comboCustomPayloadMaxDepth) throw new Error(`Custom payload cannot be nested more than ${comboCustomPayloadMaxDepth} levels.`)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateCustomValue(entry, [...path, String(index)], depth + 1))
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = [...path, key]
    if (unsafeFields.has(key)) throw new Error(`Custom payload field ${entryPath.join(".")} is not allowed.`)
    const protectedLocation = path.length === 0 || path.length === 1 && path[0] === "extra_body"
    if (protectedLocation && protectedFields.has(key)) throw new Error(`Custom payload cannot override ${entryPath.join(".")}.`)
    validateCustomValue(entry, entryPath, depth + 1)
  }
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJsonValue(value[key])]))
}

export function normalizeComboCustomPayload(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) throw new Error("Custom payload must be a JSON object.")
  validateCustomValue(value, [], 0)
  const normalized = sortedJsonValue(value) as Record<string, unknown>
  if (!Object.keys(normalized).length) return undefined
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > comboCustomPayloadMaxBytes) throw new Error("Custom payload cannot exceed 16 KB.")
  return normalized
}

export function mergeComboCustomPayload(payload: Record<string, unknown>, customPayload: Record<string, unknown> | undefined) {
  if (!customPayload) return structuredClone(payload)
  const merge = (base: unknown, override: unknown): unknown => {
    if (!isPlainObject(base) || !isPlainObject(override)) return structuredClone(override)
    const next: Record<string, unknown> = structuredClone(base)
    for (const [key, value] of Object.entries(override)) next[key] = merge(next[key], value)
    return next
  }
  return merge(payload, customPayload) as Record<string, unknown>
}

export function cleanReasoningEffort(value: unknown) {
  if (typeof value !== "string") return undefined
  const effort = value.trim().toLowerCase()
  return effort && effort.length <= 64 ? effort : undefined
}

export function comboMembers(combo: Pick<ModelCombo, "members" | "memberModelIds">): ComboMember[] {
  if (Array.isArray(combo.members) && combo.members.length) return combo.members
  return combo.memberModelIds.map((modelId) => ({ modelId, reasoning: { mode: "inherit" } }))
}

export function supportedReasoningEfforts(model: Pick<Model, "reasoningCapability"> | undefined) {
  const capability = model?.reasoningCapability
  if (capability?.mode === "disabled") return []
  const configured = capability?.supportedEfforts?.map(cleanReasoningEffort).filter((value): value is string => Boolean(value))
  return configured?.length ? [...new Set(configured)] : [...standardReasoningEfforts]
}

export function memberPolicyConfigHash(member: Pick<ComboMember, "modelId" | "reasoning" | "customPayload">) {
  return JSON.stringify([member.modelId, member.reasoning?.mode || "inherit", member.reasoning?.effort || "", sortedJsonValue(member.customPayload || {})])
}

export function stripReasoningFields(payload: Record<string, unknown>) {
  const next = structuredClone(payload)
  for (const key of ["reasoning", "reasoning_effort", "thinking", "thinking_config"]) delete next[key]
  const outputConfig = next.output_config
  if (outputConfig && typeof outputConfig === "object" && !Array.isArray(outputConfig)) {
    delete (outputConfig as Record<string, unknown>).effort
    if (!Object.keys(outputConfig).length) delete next.output_config
  }
  const google = next.google
  if (google && typeof google === "object" && !Array.isArray(google)) delete (google as Record<string, unknown>).thinking_config
  const extraBody = next.extra_body
  if (extraBody && typeof extraBody === "object" && !Array.isArray(extraBody)) {
    const extra = extraBody as Record<string, unknown>
    delete extra.reasoning
    delete extra.reasoning_effort
    delete extra.thinking
    delete extra.thinking_config
    const extraGoogle = extra.google
    if (extraGoogle && typeof extraGoogle === "object" && !Array.isArray(extraGoogle)) delete (extraGoogle as Record<string, unknown>).thinking_config
  }
  const generationConfig = next.generationConfig
  if (generationConfig && typeof generationConfig === "object" && !Array.isArray(generationConfig)) delete (generationConfig as Record<string, unknown>).thinkingConfig
  return next
}

export function applyComboMemberPolicy(payload: Record<string, unknown>, member: ComboMember): { payload: Record<string, unknown>; effort?: string; customPayload?: Record<string, unknown> } {
  const customPayload = normalizeComboCustomPayload(member.customPayload)
  const merged = mergeComboCustomPayload(payload, customPayload)
  const mode = member.reasoning?.mode || "inherit"
  if (mode === "inherit") return { payload: merged, ...(customPayload ? { customPayload } : {}) }
  const next = stripReasoningFields(merged)
  if (mode !== "override") {
    const providerPayload = customPayload ? stripReasoningFields(customPayload) : undefined
    return { payload: next, ...(providerPayload && Object.keys(providerPayload).length ? { customPayload: providerPayload } : {}) }
  }
  const effort = cleanReasoningEffort(member.reasoning?.effort)
  if (!effort) throw new Error("Reasoning effort is required when override is enabled.")
  return { payload: next, effort, ...(customPayload ? { customPayload } : {}) }
}

export function applyReasoningOverride(payload: Record<string, unknown>, effort: string | undefined, protocol: Protocol) {
  if (!effort) return structuredClone(payload)
  const reasoning = isPlainObject(payload.reasoning) ? structuredClone(payload.reasoning) : undefined
  if (reasoning) delete reasoning.effort
  const thinking = isPlainObject(payload.thinking) ? structuredClone(payload.thinking) : undefined
  if (thinking) delete thinking.type
  const next = stripReasoningFields(payload)
  if (protocol === "openai-responses") return { ...next, reasoning: { ...reasoning, effort } }
  if (protocol === "openai-chat") return { ...next, ...(reasoning && Object.keys(reasoning).length ? { reasoning } : {}), reasoning_effort: effort }

  if (effort === "none") return { ...next, thinking: { type: "disabled" } }
  if (effort === "auto") return { ...next, thinking: { type: "enabled" } }
  const outputConfig = next.output_config && typeof next.output_config === "object" && !Array.isArray(next.output_config)
    ? next.output_config as Record<string, unknown>
    : {}
  return { ...next, thinking: { ...thinking, type: "adaptive" }, output_config: { ...outputConfig, effort } }
}
