import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { closeLocalDatabase, listLocalDocuments, upsertLocalDocuments } from "@/lib/local-db"
import type { ModelPricingGroup, ModelPricingVersion, UsageEvent, UsageRollup } from "@/lib/types"

/**
 * Re-estimate aggregate usage imported from the old 9router SQLite database.
 *
 * The SQLite usage table kept full input/prompt tokens but did not keep cache
 * reads or cache creation tokens. Treating every input token as billable makes
 * long-lived Codex contexts materially too expensive. This tool calibrates the
 * missing cache split from exact request events and recalculates only the
 * legacy aggregate rows. It is deliberately idempotent: rows carrying the
 * marker below are never estimated a second time.
 */

type LocalDocument = Awaited<ReturnType<typeof listLocalDocuments>>[number]
type Rates = Pick<ModelPricingVersion, "inputMicrosPerMillion" | "outputMicrosPerMillion" | "cacheReadMicrosPerMillion" | "cacheCreationMicrosPerMillion">
type Sample = { input: number; cacheRead: number; cacheCreation: number; output: number }
type Calibration = { sampleCount: number; input: number; cacheRead: number; cacheCreation: number }
type Scope = {
  id: string
  eventsPath: string
  rollupsPath: string
  groupsPath: string
  versionsPath: string
  modelsPrefix: string
}
type CalibrationMaps = {
  byKeyModelDay: Map<string, Sample[]>
  byKeyModel: Map<string, Sample[]>
  byModelDay: Map<string, Sample[]>
  byModel: Map<string, Sample[]>
}
type TokenAccountingSemantics = "subset" | "independent" | "separate-reasoning" | "unknown"
type Prediction = {
  costMicros: number
  calculatedCostMicros: number
  cappedAtSourceCost: boolean
  method: "same-key-model-day" | "same-key-model" | "same-model-day" | "same-model"
  sampleCount: number
  cacheReadFraction: number
  cacheCreationFraction: number
  semantics: TokenAccountingSemantics
}

// Keep this in lockstep with CLIProxyAPI/sdk/cliproxy/usage/accounting.go.
// The old SQLite rows only contain aggregate prompt/completion counts, so an
// estimate is safe only where the upstream contract says cache buckets are a
// subset of input tokens. Independent cache semantics cannot be reconstructed
// from the legacy shape without inventing whether promptTokens was cached or
// uncached input, and unknown providers must remain unknown.
const marker = "legacy-cliproxy-cache-aware-v2"
const supersededMarkers = new Set(["legacy-cache-aware-v1", marker])
const apply = process.argv.includes("--apply")
const prefix = (process.env.DATABASE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")
const minimumSamples = 8
const fromArgument = process.argv.find((argument) => argument.startsWith("--from="))?.slice("--from=".length)
const toArgument = process.argv.find((argument) => argument.startsWith("--to="))?.slice("--to=".length)
const from = fromArgument ? Date.parse(fromArgument) : Date.parse("2000-01-01T00:00:00.000Z")
const to = toArgument ? Date.parse(toArgument) : Date.parse("2999-01-01T00:00:00.000Z")

function scopeForCollection(collectionPath: string): Scope | undefined {
  if (collectionPath === `${prefix}_usage_events`) return {
    id: "default",
    eventsPath: collectionPath,
    rollupsPath: `${prefix}_usage_rollups`,
    groupsPath: `${prefix}_model_pricing_groups`,
    versionsPath: `${prefix}_model_pricing_versions`,
    modelsPrefix: `${prefix}/providers/providers/`,
  }
  const eventMatch = collectionPath.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}_workspaces/([^/]+)/usageEvents$`))
  if (!eventMatch) return undefined
  const id = eventMatch[1]
  const base = `${prefix}_workspaces/${id}`
  return {
    id,
    eventsPath: collectionPath,
    rollupsPath: `${base}/usageRollups`,
    groupsPath: `${base}/modelPricingGroups`,
    versionsPath: `${base}/modelPricingVersions`,
    modelsPrefix: `${base}/providers/`,
  }
}

function scopeForRollupCollection(collectionPath: string): Scope | undefined {
  if (collectionPath === `${prefix}_usage_rollups`) return scopeForCollection(`${prefix}_usage_events`)
  const match = collectionPath.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}_workspaces/([^/]+)/usageRollups$`))
  return match ? scopeForCollection(`${prefix}_workspaces/${match[1]}/usageEvents`) : undefined
}

function number(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function integer(value: unknown) {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(number(value))))
}

function utcDay(timestamp: string) {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "unknown"
}

function keyModel(keyId: string, modelId: string) {
  return `${keyId}\u0000${modelId}`
}

function keyModelDay(keyId: string, modelId: string, day: string) {
  return `${keyModel(keyId, modelId)}\u0000${day}`
}

function modelDay(modelId: string, day: string) {
  return `${modelId}\u0000${day}`
}

function tokenAccountingSemanticsForGatewayModel(gatewayModelId: string): TokenAccountingSemantics {
  const provider = gatewayModelId.trim().split("/", 1)[0].toLowerCase()
  if (!provider || provider === gatewayModelId.trim().toLowerCase()) return "unknown"
  if (provider === "openai-compatibility" || provider.startsWith("openai-compatible-") || [
    "openai", "codex", "xai", "grok", "kimi", "qwen", "deepseek", "openrouter",
  ].includes(provider)) return "subset"
  if (provider.includes("claude") || provider.includes("anthropic")) return "independent"
  if (["gemini", "aistudio", "antigravity", "vertex", "interaction"].some((marker) => provider.includes(marker))) return "separate-reasoning"
  return "unknown"
}

function addSample(map: Map<string, Sample[]>, key: string, sample: Sample) {
  const samples = map.get(key) || []
  samples.push(sample)
  map.set(key, samples)
}

function aggregate(samples: Sample[]): Calibration {
  return samples.reduce((result, sample) => ({
    sampleCount: result.sampleCount + 1,
    input: result.input + sample.input,
    cacheRead: result.cacheRead + sample.cacheRead,
    cacheCreation: result.cacheCreation + sample.cacheCreation,
  }), { sampleCount: 0, input: 0, cacheRead: 0, cacheCreation: 0 })
}

function safeFraction(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function selectCalibration(
  keyId: string,
  modelId: string,
  day: string,
  maps: CalibrationMaps,
): { calibration: Calibration; method: Prediction["method"] } | undefined {
  const candidates: Array<{ samples: Sample[] | undefined; method: Prediction["method"] }> = [
    { samples: maps.byKeyModelDay.get(keyModelDay(keyId, modelId, day)), method: "same-key-model-day" },
    { samples: maps.byKeyModel.get(keyModel(keyId, modelId)), method: "same-key-model" },
    { samples: maps.byModelDay.get(modelDay(modelId, day)), method: "same-model-day" },
    { samples: maps.byModel.get(modelId), method: "same-model" },
  ]
  for (const candidate of candidates) {
    if (!candidate.samples || candidate.samples.length < minimumSamples) continue
    return { calibration: aggregate(candidate.samples), method: candidate.method }
  }
  return undefined
}

function estimate(
    row: Record<string, unknown>,
    rates: Rates,
    selected: { calibration: Calibration; method: Prediction["method"] },
    semantics: TokenAccountingSemantics,
    sourceCostMicros: number,
): Prediction | undefined {
  const input = integer(row.inputTokens)
  const output = integer(row.outputTokens)
  if (input <= 0 && output <= 0) return undefined
  const calibration = selected.calibration
  if (calibration.input <= 0) return undefined
  const cacheReadFraction = safeFraction(calibration.cacheRead / calibration.input)
  const cacheCreationFraction = Math.min(
    safeFraction(calibration.cacheCreation / calibration.input),
    Math.max(0, 1 - cacheReadFraction),
  )
  const cacheRead = Math.min(input, Math.round(input * cacheReadFraction))
  const cacheCreation = Math.min(input - cacheRead, Math.round(input * cacheCreationFraction))
  const billableInput = Math.max(input - cacheRead - cacheCreation, 0)
  const numerator = BigInt(billableInput) * BigInt(rates.inputMicrosPerMillion)
    + BigInt(cacheRead) * BigInt(rates.cacheReadMicrosPerMillion)
    + BigInt(cacheCreation) * BigInt(rates.cacheCreationMicrosPerMillion)
    + BigInt(output) * BigInt(rates.outputMicrosPerMillion)
  const roundedMicros = (numerator + BigInt(500_000)) / BigInt(1_000_000)
  const calculatedCostMicros = roundedMicros > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(roundedMicros)
  // The legacy provider-recorded amount is the only historical dollar fact we
  // have. Cache evidence can establish that it was too high, but cannot prove
  // that a catalog recalculation is allowed to increase it (prices may have
  // changed, or the old provider may have used a different tier). Keep that
  // source amount as a hard ceiling.
  const cappedAtSourceCost = calculatedCostMicros > sourceCostMicros
  return {
    costMicros: Math.max(0, Math.min(calculatedCostMicros, sourceCostMicros)),
    calculatedCostMicros,
    cappedAtSourceCost,
    method: selected.method,
    sampleCount: calibration.sampleCount,
    cacheReadFraction,
    cacheCreationFraction,
    semantics,
  }
}

function modelRates(documents: LocalDocument[], scope: Scope, gatewayModelId: string, asOf: string): Rates | undefined {
  const models = documents
    .filter((document) => document.collection_path.startsWith(scope.modelsPrefix) && document.collection_path.endsWith("/models"))
    .filter((document) => document.data.gatewayModelId === gatewayModelId)
  if (models.length !== 1) return undefined
  const group = documents
    .filter((document) => document.collection_path === scope.groupsPath)
    .map((document) => ({ ...document.data, id: document.document_id } as ModelPricingGroup))
    .find((candidate) => candidate.memberModelIds?.includes(models[0].document_id))
  if (!group) return undefined
  const versions = documents
    .filter((document) => document.collection_path === scope.versionsPath && document.data.groupId === group.id)
    .map((document) => ({ ...document.data, id: document.document_id } as ModelPricingVersion))
    .sort((left, right) => Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt))
  const asOfMs = Date.parse(asOf)
  const effectiveVersion = versions.find((candidate) => {
    const effectiveAt = Date.parse(candidate.effectiveAt)
    return Number.isFinite(effectiveAt) && effectiveAt <= asOfMs
  })
  // RawRoute has no historical price snapshot before the first catalog
  // version, and CLIProxyAPI does not provide dollar prices. Use the earliest
  // configured version only as a transparent pre-catalog fallback; the
  // source-cost ceiling below prevents this fallback from inflating history.
  const version = effectiveVersion || versions.at(-1)
  if (!version) return undefined
  const rates = {
    inputMicrosPerMillion: integer(version.inputMicrosPerMillion),
    outputMicrosPerMillion: integer(version.outputMicrosPerMillion),
    cacheReadMicrosPerMillion: integer(version.cacheReadMicrosPerMillion),
    cacheCreationMicrosPerMillion: integer(version.cacheCreationMicrosPerMillion),
  }
  return Object.values(rates).every((value) => Number.isSafeInteger(value)) ? rates : undefined
}

function readCalibrationMaps(): CalibrationMaps {
  return { byKeyModelDay: new Map(), byKeyModel: new Map(), byModelDay: new Map(), byModel: new Map() }
}

async function writeBatches(writes: Array<{ path: string; data: object }>) {
  for (let offset = 0; offset < writes.length; offset += 300) await upsertLocalDocuments(writes.slice(offset, offset + 300))
}

async function main() {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("Invalid --from/--to range.")
  const documents = await listLocalDocuments()
  const scopes = new Map<string, Scope>()
  for (const document of documents) {
    const scope = scopeForCollection(document.collection_path) || scopeForRollupCollection(document.collection_path)
    if (scope) scopes.set(scope.id, scope)
  }

  const calibrations = new Map<string, CalibrationMaps>()
  for (const scope of scopes.values()) calibrations.set(scope.id, readCalibrationMaps())
  for (const document of documents) {
    const scope = scopeForCollection(document.collection_path)
    if (!scope) continue
    const event = document.data as unknown as UsageEvent
    if (event.status < 200 || event.status >= 300 || event.pricingConfidence !== "exact" || event.usageAvailable !== true || !event.gatewayModelId) continue
    const input = integer(event.inputTokens)
    const cacheRead = Math.min(input, integer(event.cacheReadTokens))
    const cacheCreation = Math.min(input - cacheRead, integer(event.cacheCreationTokens))
    if (input <= 0) continue
    const sample = { input, cacheRead, cacheCreation, output: integer(event.outputTokens) }
    const maps = calibrations.get(scope.id) || readCalibrationMaps()
    calibrations.set(scope.id, maps)
    addSample(maps.byKeyModelDay, keyModelDay(event.gatewayKeyId, event.gatewayModelId, utcDay(event.completedAt)), sample)
    addSample(maps.byKeyModel, keyModel(event.gatewayKeyId, event.gatewayModelId), sample)
    addSample(maps.byModelDay, modelDay(event.gatewayModelId, utcDay(event.completedAt)), sample)
    addSample(maps.byModel, event.gatewayModelId, sample)
  }

  const updates: Array<{ path: string; data: UsageRollup; beforeCost: number; prediction: Prediction; scopeId: string }> = []
  const skipped = new Map<string, number>()
  for (const document of documents) {
    const scope = scopeForRollupCollection(document.collection_path)
    if (!scope || document.data.backfillSource !== "legacy-9router-keyed-usage-history") continue
    const rollup = document.data as unknown as UsageRollup
    if (rollup.granularity !== "hourly" && rollup.granularity !== "daily") continue
    const bucketMs = Date.parse(rollup.bucketStart)
    if (!Number.isFinite(bucketMs) || bucketMs < from || bucketMs >= to || (rollup.reconciledFrom && supersededMarkers.has(rollup.reconciledFrom))) continue
    if (!rollup.gatewayKeyId || !rollup.gatewayModelId) {
      skipped.set("missing-dimension", (skipped.get("missing-dimension") || 0) + 1)
      continue
    }
    const semantics = tokenAccountingSemanticsForGatewayModel(rollup.gatewayModelId)
    // Independent cache buckets (Anthropic) and separate reasoning buckets
    // (Gemini-family) need fields the SQLite aggregate never retained. This
    // follows CLIProxyAPI's explicit non-guessing behavior.
    if (semantics !== "subset") {
      skipped.set(`unsupported-semantics:${semantics}:${rollup.gatewayModelId}`, (skipped.get(`unsupported-semantics:${semantics}:${rollup.gatewayModelId}`) || 0) + 1)
      continue
    }
    const rates = modelRates(documents, scope, rollup.gatewayModelId, rollup.bucketStart)
    if (!rates) {
      skipped.set(`missing-pricing:${rollup.gatewayModelId}`, (skipped.get(`missing-pricing:${rollup.gatewayModelId}`) || 0) + 1)
      continue
    }
    const maps = calibrations.get(scope.id)
    const selected = maps && selectCalibration(rollup.gatewayKeyId, rollup.gatewayModelId, utcDay(rollup.bucketStart), maps)
    if (!selected) {
      skipped.set(`missing-calibration:${rollup.gatewayModelId}`, (skipped.get(`missing-calibration:${rollup.gatewayModelId}`) || 0) + 1)
      continue
    }
    const sourceCostMicros = integer(rollup.costMicros)
    if (sourceCostMicros <= 0) {
      skipped.set("zero-source-cost", (skipped.get("zero-source-cost") || 0) + 1)
      continue
    }
    const prediction = estimate(document.data, rates, selected, semantics, sourceCostMicros)
    if (!prediction) {
      skipped.set("missing-tokens", (skipped.get("missing-tokens") || 0) + 1)
      continue
    }
    const requests = integer(rollup.requests)
    const failedRequests = Math.min(requests, integer(rollup.failedRequests))
    const next: UsageRollup = {
      ...rollup,
      costMicros: prediction.costMicros,
      pricedRequests: 0,
      unpricedRequests: Math.max(0, requests - failedRequests),
      costSource: "empirical",
      reconciledFrom: marker,
      updatedAt: new Date().toISOString(),
    }
    updates.push({ path: document.path, data: next, beforeCost: integer(rollup.costMicros), prediction, scopeId: scope.id })
  }

  const summary = new Map<string, { rows: number; requests: number; before: number; after: number; methods: Record<string, number>; sourceCostCaps: number }>()
  for (const update of updates) {
    const key = `${update.scopeId}\u0000${update.data.gatewayKeyId}\u0000${update.data.gatewayModelId}`
    const current = summary.get(key) || { rows: 0, requests: 0, before: 0, after: 0, methods: {}, sourceCostCaps: 0 }
    current.rows += 1
    current.requests += integer(update.data.requests)
    current.before += update.beforeCost
    current.after += update.prediction.costMicros
    current.methods[update.prediction.method] = (current.methods[update.prediction.method] || 0) + 1
    current.sourceCostCaps += update.prediction.cappedAtSourceCost ? 1 : 0
    summary.set(key, current)
  }

  let backupPath: string | undefined
  const backupDirectory = process.env.USAGE_ESTIMATE_BACKUP_DIR
  if (apply && updates.length) {
    if (backupDirectory) {
      await mkdir(backupDirectory, { recursive: true })
      backupPath = join(backupDirectory, `legacy-cache-aware-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}.jsonl`)
      await writeFile(backupPath, updates.map((update) => JSON.stringify({ path: update.path, data: documents.find((document) => document.path === update.path)?.data || null })).join("\n") + "\n", "utf8")
    }
    await writeBatches(updates.map((update) => ({ path: update.path, data: update.data })))
  }

  const totals = updates.reduce((result, update) => ({
    rows: result.rows + 1,
    requests: result.requests + integer(update.data.requests),
    before: result.before + update.beforeCost,
    after: result.after + update.prediction.costMicros,
  }), { rows: 0, requests: 0, before: 0, after: 0 })
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    marker,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    minimumSamples,
    candidates: updates.length,
    totals: {
      ...totals,
      beforeUsd: totals.before / 1_000_000,
      afterUsd: totals.after / 1_000_000,
      deltaUsd: (totals.after - totals.before) / 1_000_000,
    },
    byKeyModel: [...summary.entries()].map(([key, value]) => {
      const [scopeId, gatewayKeyId, gatewayModelId] = key.split("\u0000")
      return { scopeId, gatewayKeyId, gatewayModelId, ...value, beforeUsd: value.before / 1_000_000, afterUsd: value.after / 1_000_000, deltaUsd: (value.after - value.before) / 1_000_000 }
    }).sort((left, right) => right.before - left.before),
    skipped: Object.fromEntries(skipped),
    ...(backupPath ? { backupPath } : {}),
  }, null, 2))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}).finally(() => closeLocalDatabase())
