import { timingSafeEqual } from "node:crypto"
import { signComboConfirmation } from "../../../../signing"

import { invalidateDashboardPresentation } from "../../../../analytics"
import { cleanReasoningEffort, memberPolicyConfigHash, normalizeComboCustomPayload } from "../../../../../contracts/combo-reasoning"
import { testComboMemberPolicy, type ComboMemberTestResult } from "../../../../cliproxy/gateway"
import { jsonError } from "@rawroute/observability/contracts/http"
import { cleanAliasId } from "../../../../model-identifiers"
import { recordLog } from "../../../../logging"
import { getSharedModelForRecipient, listSharedModelsForRecipient } from "../../../../model-shares"
import { listCombos, listModels, listProviders, upsertCombo } from "../../../../store"
import type { ComboMember, ModelCombo } from "../../../../../contracts/domain"

export async function GET() {
  const [combos, models, providers, sharedModels] = await Promise.all([listCombos(), listModels(), listProviders(), listSharedModelsForRecipient()])
  const enabledProviders = new Set(providers.filter((provider) => provider.enabled !== false).map((provider) => provider.id))
  return Response.json({ combos, models: models.filter((model) => model.enabled && enabledProviders.has(model.providerId)), sharedModels })
}

function normalizedMembers(input: Partial<ModelCombo>) {
  const raw: ComboMember[] = Array.isArray(input.members) ? input.members : []
  return raw.map((member): ComboMember => {
    const modelId = typeof member.modelId === "string" ? member.modelId.trim() : ""
    const mode = member.reasoning?.mode || "inherit"
    const effort = mode === "override" ? cleanReasoningEffort(member.reasoning?.effort) : undefined
    if (!["inherit", "provider-default", "override"].includes(mode)) throw new Error("Combo reasoning mode is invalid.")
    if (mode === "override" && !effort) throw new Error("Reasoning effort is required when override is enabled.")
    const customPayload = normalizeComboCustomPayload(member.customPayload)
    const sharedModelId = typeof member.sharedModelId === "string" ? member.sharedModelId.trim() : undefined
    return { modelId, ...(sharedModelId ? { sharedModelId } : {}), reasoning: { mode, ...(effort ? { effort } : {}) }, ...(customPayload ? { customPayload } : {}), validation: member.validation }
  })
}

async function confirmationToken(members: ComboMember[]) {
  const expiresAt = Date.now() + 5 * 60_000
  const value = `${expiresAt}.${JSON.stringify(members.map(memberPolicyConfigHash))}`
  const signature = await signComboConfirmation(value)
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
    const expectedValue = `${expiresAt}.${JSON.stringify(members.map(memberPolicyConfigHash))}`
    if (value !== expectedValue) return false
    const expected = await signComboConfirmation(value)
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
  if (memberModelIds.length < 1 || memberModelIds.length > 8) throw new Error("A combo needs between 1 and 8 models.")
  if (new Set(memberModelIds).size !== memberModelIds.length || memberModelIds.some((member) => !member)) throw new Error("Combo models must be unique.")

  const [models, providers, combos] = await Promise.all([listModels(), listProviders(), listCombos()])
  const enabledProviderIds = new Set(providers.filter((provider) => provider.enabled !== false).map((provider) => provider.id))
  const availableModelIds = new Set(models.filter((model) => model.enabled && enabledProviderIds.has(model.providerId)).map((model) => model.gatewayModelId || model.id))
  await Promise.all(members.map(async (member) => {
    if (member.sharedModelId) {
      const shared = await getSharedModelForRecipient(member.sharedModelId)
      if (!shared || shared.status !== "active" || shared.qualifiedModelId !== member.modelId) throw new Error("Shared model is no longer available.")
    } else if (!availableModelIds.has(member.modelId)) throw new Error("One or more combo models are unavailable.")
  }))
  if (availableModelIds.has(combo) || combos.some((entry) => cleanAliasId(entry.combo) === combo && entry.id !== input.originalId)) throw new Error("Combo gateway ID is already in use.")
  return { combo, name, members, existing: input.originalId ? combos.find((entry) => entry.id === input.originalId) : undefined }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const input = body?.combo as Partial<ModelCombo> & { originalId?: string } | undefined
  if (!input) return jsonError("Combo payload is required.", 400)
  try {
    const value = await validateCombo(input)
    const existingByModel = new Map(value.existing?.members?.map((member) => [member.modelId, member]) || [])
    const cachedValidation = new Map<string, ComboMember["validation"]>()
    const policyMembers = value.members.filter((member) => member.reasoning?.mode === "override" || member.customPayload)
    const membersToTest = policyMembers.filter((member) => {
      const existing = existingByModel.get(member.modelId)
      const hash = memberPolicyConfigHash(member)
      if (existing?.validation?.configHash === hash && existing.validation.status !== "stale" && existing.validation.status !== "invalid") {
        cachedValidation.set(member.modelId, existing.validation)
        return false
      }
      return true
    })
    const results: ComboMemberTestResult[] = []
    for (let index = 0; index < membersToTest.length; index += 2) results.push(...await Promise.all(membersToTest.slice(index, index + 2).map(testComboMemberPolicy)))
    const invalid = results.filter((result) => result.status === "invalid")
    if (invalid.length) return jsonError("One or more member policies were rejected by the upstream.", 400, { results: invalid })
    const unverified = results.filter((result) => result.status === "unverified")
    if (unverified.length && !await validConfirmation(body?.confirmationToken, value.members)) {
      return jsonError("Some member policies could not be verified.", 409, { results: unverified, confirmationToken: await confirmationToken(value.members) })
    }
    const testedAt = new Date().toISOString()
    value.members = value.members.map((member) => {
      if (member.reasoning?.mode !== "override" && !member.customPayload) return { ...member, validation: undefined }
      const cached = cachedValidation.get(member.modelId)
      if (cached) return { ...member, validation: cached }
      const result = results.find((entry) => entry.modelId === member.modelId)!
      return { ...member, validation: { status: result.status, testedAt, message: result.message, configHash: memberPolicyConfigHash(member) } }
    })
    const combo = await upsertCombo({ ...value, originalId: input.originalId })
    invalidateDashboardPresentation()
    recordLog("admin.combo.saved", { combo: combo.combo }, { level: "info" })
    return Response.json({ combo })
  } catch (error) {
    recordLog("admin.combo.save.failed", { error: error instanceof Error ? error.message : "Unknown error" }, { level: "error" })
    return jsonError(error instanceof Error ? error.message : "Unable to save combo.", 400)
  }
}
