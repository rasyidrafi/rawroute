import type { ComboMember, Model, ModelCombo, Protocol } from "@/lib/types"

export const standardReasoningEfforts = ["none", "auto", "minimal", "low", "medium", "high", "xhigh", "max"] as const

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

export function reasoningConfigHash(modelId: string, mode: string, effort?: string) {
  return JSON.stringify([modelId, mode, effort || ""])
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

export function applyComboMemberPolicy(payload: Record<string, unknown>, member: ComboMember) {
  const mode = member.reasoning?.mode || "inherit"
  if (mode === "inherit") return { payload: structuredClone(payload), effort: undefined }
  const next = stripReasoningFields(payload)
  if (mode !== "override") return { payload: next, effort: undefined }
  const effort = cleanReasoningEffort(member.reasoning?.effort)
  if (!effort) throw new Error("Reasoning effort is required when override is enabled.")
  return { payload: next, effort }
}

export function applyReasoningOverride(payload: Record<string, unknown>, effort: string | undefined, protocol: Protocol) {
  if (!effort) return structuredClone(payload)
  const next = stripReasoningFields(payload)
  if (protocol === "openai-responses") return { ...next, reasoning: { effort } }
  if (protocol === "openai-chat") return { ...next, reasoning_effort: effort }

  if (effort === "none") return { ...next, thinking: { type: "disabled" } }
  if (effort === "auto") return { ...next, thinking: { type: "enabled" } }
  const outputConfig = next.output_config && typeof next.output_config === "object" && !Array.isArray(next.output_config)
    ? next.output_config as Record<string, unknown>
    : {}
  return { ...next, thinking: { type: "adaptive" }, output_config: { ...outputConfig, effort } }
}
