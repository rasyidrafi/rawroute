import { createHmac, timingSafeEqual } from "node:crypto"

import { requireAdmin } from "@/lib/auth"
import { invalidateDashboardPresentation } from "@/lib/analytics"
import { cleanReasoningEffort, reasoningConfigHash } from "@/lib/combo-reasoning"
import { testComboMemberReasoning, type ComboMemberTestResult } from "@/lib/cliproxy"
import { cleanAliasId, jsonError } from "@/lib/http"
import { writeLog } from "@/lib/logger"
import { getSharedModelForRecipient } from "@/lib/model-shares"
import { listAliases, listCombos, listModels, listProviders, readSessionSecret, upsertCombo } from "@/lib/store"
import type { ComboMember, ModelCombo } from "@/lib/types"

function normalizedMembers(input: Partial<ModelCombo>) {
  const raw = Array.isArray(input.members) ? input.members : Array.isArray(input.memberModelIds) ? input.memberModelIds.map((modelId) => ({ modelId })) : []
  return raw.map((member): ComboMember => {
    const modelId = typeof member.modelId === "string" ? member.modelId.trim() : ""
    const mode = member.reasoning?.mode || "inherit"
    const effort = mode === "override" ? cleanReasoningEffort(member.reasoning?.effort) : undefined
    if (!["inherit", "provider-default", "override"].includes(mode)) throw new Error("Combo reasoning mode is invalid.")
    if (mode === "override" && !effort) throw new Error("Reasoning effort is required when override is enabled.")
    return { modelId, reasoning: { mode, ...(effort ? { effort } : {}) }, validation: member.validation }
  })
}

async function confirmationToken(members: ComboMember[]) {
  const expiresAt = Date.now() + 5 * 60_000
  const value = `${expiresAt}.${JSON.stringify(members.map((member) => [member.modelId, member.reasoning]))}`
  const signature = createHmac("sha256", await readSessionSecret()).update(value).digest("base64url")
  return Buffer.from(`${value}.${signature}`).toString("base64url")
}

async function validConfirmation(token: unknown, members: ComboMember[]) {
  if (typeof token !== "string") return false
  try {
    const decoded = Buffer.from(token, "base64url").toString()
    const split = decoded.lastIndexOf(".")
    const value = decoded.slice(0, split)
    const signature = decoded.slice(split + 1)
    const expiresAt = Number(value.slice(0, value.indexOf(".")))
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false
    const expectedValue = `${expiresAt}.${JSON.stringify(members.map((member) => [member.modelId, member.reasoning]))}`
    if (value !== expectedValue) return false
    const expected = createHmac("sha256", await readSessionSecret()).update(value).digest("base64url")
    const left = Buffer.from(signature)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right)
  } catch { return false }
}

async function validateCombo(input: Partial<ModelCombo> & { originalId?: string }) {
  const combo = cleanAliasId(typeof input.combo === "string" ? input.combo : "")
  const name = typeof input.name === "string" ? input.name.trim() : ""
  const members = normalizedMembers(input)
  const memberModelIds = members.map((member) => member.modelId)
  if (!combo || !name) throw new Error("Combo fields are incomplete.")
  if (memberModelIds.length < 2 || memberModelIds.length > 8) throw new Error("A combo needs between 2 and 8 models.")
  if (new Set(memberModelIds).size !== memberModelIds.length || memberModelIds.some((member) => !member)) throw new Error("Combo models must be unique.")

  const [models, providers, aliases, combos] = await Promise.all([listModels(), listProviders(), listAliases(), listCombos()])
  const enabledProviderIds = new Set(providers.filter((provider) => provider.enabled !== false).map((provider) => provider.id))
  const availableModelIds = new Set(models.filter((model) => model.enabled && enabledProviderIds.has(model.providerId)).map((model) => model.gatewayModelId || model.id))
  const availableAliasIds = new Set<string>()
  for (const alias of aliases) {
    if (!alias.sharedModelId && availableModelIds.has(alias.targetModelId)) availableAliasIds.add(alias.alias)
    if (alias.sharedModelId && (await getSharedModelForRecipient(alias.sharedModelId))?.status === "active") availableAliasIds.add(alias.alias)
  }
  if (memberModelIds.some((member) => !availableModelIds.has(member) && !availableAliasIds.has(member))) throw new Error("One or more combo models are unavailable.")
  if (availableModelIds.has(combo) || aliases.some((alias) => cleanAliasId(alias.alias) === combo) || combos.some((entry) => cleanAliasId(entry.combo) === combo && entry.id !== input.originalId)) throw new Error("Combo gateway ID is already in use.")
  return { combo, name, members, memberModelIds }
}

export async function POST(request: Request) {
  try { (await requireAdmin())() } catch { return jsonError("Unauthorized", 401) }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const input = body?.combo as Partial<ModelCombo> & { originalId?: string } | undefined
  if (!input) return jsonError("Combo payload is required.", 400)
  try {
    const value = await validateCombo(input)
    const overrideMembers = value.members.filter((member) => member.reasoning?.mode === "override")
    const results: ComboMemberTestResult[] = []
    for (let index = 0; index < overrideMembers.length; index += 2) results.push(...await Promise.all(overrideMembers.slice(index, index + 2).map(testComboMemberReasoning)))
    const invalid = results.filter((result) => result.status === "invalid")
    if (invalid.length) return jsonError("One or more reasoning overrides were rejected by the upstream.", 400, { results: invalid })
    const unverified = results.filter((result) => result.status === "unverified")
    if (unverified.length && !await validConfirmation(body?.confirmationToken, value.members)) {
      return jsonError("Some reasoning overrides could not be verified.", 409, { results: unverified, confirmationToken: await confirmationToken(value.members) })
    }
    const testedAt = new Date().toISOString()
    value.members = value.members.map((member) => {
      if (member.reasoning?.mode !== "override") return { ...member, validation: undefined }
      const result = results.find((entry) => entry.modelId === member.modelId)!
      return { ...member, validation: { status: result.status, testedAt, message: result.message, configHash: reasoningConfigHash(member.modelId, member.reasoning.mode, member.reasoning.effort) } }
    })
    const combo = await upsertCombo({ ...value, originalId: input.originalId })
    invalidateDashboardPresentation()
    writeLog("info", "admin", "Combo saved", { combo: combo.combo })
    return Response.json({ combo })
  } catch (error) {
    writeLog("error", "admin", "Combo save failed", { error: error instanceof Error ? error.message : "Unknown error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save combo.", 400)
  }
}
