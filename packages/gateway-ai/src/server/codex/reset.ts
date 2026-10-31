import { createHash } from "node:crypto"
import { appendAuditSqlite, appendMemoryAudit, auditRemoteOperation } from "@rawroute/platform/server/audit"
import { getDatabase, getSqliteDatabase } from "@rawroute/platform/server/database"
import { mapConcurrent } from "@rawroute/platform/server/concurrency"
import { listWorkspaces } from "@rawroute/platform/server/runtime"
import { collectionPrefix, isMemoryBackend } from "@rawroute/platform/server/storage-config"
import { currentWorkspaceId, runInWorkspace, workspaceContext, type WorkspaceContext } from "@rawroute/platform/server/workspace-context"
import type { CodexAutoRedeemAccountStatus, CodexAutoRedeemResponse, CodexAutoRedeemSettings, CodexResetCoordinatorPhase } from "../../contracts/codex"
import type { ProviderApiKey } from "../../contracts/domain"
import { recordLog } from "../logging"
import { admitGatewayExecution, GatewayDrainConflict } from "../gateway/admission"
import { getCodexCredential } from "../codex-credentials"
import { assertCodexResetSchema } from "../codex-reset-schema"
import { aiLocalDatabase } from "../local-db"
import { fetchCodexAccount } from "./upstream"
import { listCodexAccounts } from "./oauth"
import { fetchFreshCodexUsageForReset, invalidateCodexUsageCache } from "./usage"

const consumeUrl = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
const expiryWindowMs = 60 * 60 * 1000
const staleIntentMs = 30_000
const pollIntervalMs = 60_000
const defaultSettings: CodexAutoRedeemSettings = { expiryEnabled: true, weeklyExhaustionEnabled: false }
type StoredSettings = CodexAutoRedeemSettings & { weeklyActivationId?: string; weeklyActivatedAt?: string }

type PreviousPhase = "idle" | "redeemed" | "unknown"
type CoordinatorRecord = CodexAutoRedeemAccountStatus & {
  lockToken?: string
  checkingAt?: string
  previousPhase?: PreviousPhase
  deletionToken?: string
  deletionStartedAt?: string
  attemptCreditCount?: number
  blockedCreditCount?: number
  attemptInventoryKnown?: boolean
  blockedInventoryKnown?: boolean
  weeklyActivationId?: string
  weeklyNotBefore?: string
}
type MemoryWorkspace = { settings?: StoredSettings; accounts: Map<string, CoordinatorRecord> }
type ResetScheduler = { timer?: ReturnType<typeof setInterval>; running?: Promise<void>; active: boolean; checks: Map<string, Promise<void>>; queued: Set<string>; wakeups: Map<string, ReturnType<typeof setTimeout>> }
type ResetApiCall = (account: ProviderApiKey, input: { method: string; url: string; headers?: Record<string, string>; data?: string }) => Promise<{ status: number; body: string }>

declare global {
  var __rawrouteCodexResetMemory: Map<string, MemoryWorkspace> | undefined
  var __rawrouteCodexResetScheduler: ResetScheduler | undefined
}

const resetMemory = () => globalThis.__rawrouteCodexResetMemory ||= new Map<string, MemoryWorkspace>()
const scheduler = (): ResetScheduler => globalThis.__rawrouteCodexResetScheduler ||= { active: false, checks: new Map(), queued: new Set(), wakeups: new Map() }
let resetApiCallOverride: ResetApiCall | undefined

function memoryWorkspace(workspaceId = currentWorkspaceId()) {
  const workspaces = resetMemory()
  let workspace = workspaces.get(workspaceId)
  if (!workspace) {
    workspace = { accounts: new Map() }
    workspaces.set(workspaceId, workspace)
  }
  return workspace
}

function settingsRef() {
  assertResetSchema()
  return getSqliteDatabase().collection(`${collectionPrefix()}_workspaces`).doc(currentWorkspaceId()).collection("codexResetAutomation").doc("settings")
}

function accountsRef() {
  assertResetSchema()
  return getSqliteDatabase().collection(`${collectionPrefix()}_workspaces`).doc(currentWorkspaceId()).collection("codexResetAutomationAccounts")
}

function accountRef(accountId: string) { return accountsRef().doc(accountId) }

function assertResetSchema() {
  if (isMemoryBackend()) return
  aiLocalDatabase()
  assertCodexResetSchema(getDatabase())
}

/** The workspace scopes the record; hashing keeps upstream identity out of document IDs. */
function resetIdentityKey(account: ProviderApiKey) {
  if (account.credentialKind !== "codex-oauth" || !account.accountId) throw new Error("Codex account identity is unavailable.")
  return `account-${createHash("sha256").update(account.accountId).digest("hex")}`
}

function parseSettings(value: unknown): StoredSettings {
  const data = objectValue(value)
  return {
    expiryEnabled: typeof data?.expiryEnabled === "boolean" ? data.expiryEnabled : defaultSettings.expiryEnabled,
    weeklyExhaustionEnabled: typeof data?.weeklyExhaustionEnabled === "boolean" ? data.weeklyExhaustionEnabled : defaultSettings.weeklyExhaustionEnabled,
    ...(typeof data?.weeklyActivationId === "string" ? { weeklyActivationId: data.weeklyActivationId } : {}),
    ...(typeof data?.weeklyActivatedAt === "string" ? { weeklyActivatedAt: data.weeklyActivatedAt } : {}),
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parseRecord(value: unknown): CoordinatorRecord | undefined {
  const data = objectValue(value)
  const phases: CodexResetCoordinatorPhase[] = ["idle", "checking", "pending", "unknown", "redeemed", "deleting"]
  if (!data || !phases.includes(data.phase as CodexResetCoordinatorPhase)) return undefined
  const status: CoordinatorRecord = { phase: data.phase as CodexResetCoordinatorPhase }
  for (const key of ["lastCheckedAt", "lastAttemptAt", "requestId", "lastMessage", "creditExpiresAt", "lockToken", "checkingAt", "deletionToken", "deletionStartedAt", "weeklyActivationId", "weeklyNotBefore"] as const) {
    if (typeof data[key] === "string") status[key] = data[key]
  }
  for (const key of ["attemptCreditCount", "blockedCreditCount"] as const) {
    if (typeof data[key] === "number" && Number.isSafeInteger(data[key]) && data[key] >= 0) status[key] = data[key]
  }
  for (const key of ["attemptInventoryKnown", "blockedInventoryKnown"] as const) {
    if (typeof data[key] === "boolean") status[key] = data[key]
  }
  if (data.previousPhase === "idle" || data.previousPhase === "redeemed" || data.previousPhase === "unknown") status.previousPhase = data.previousPhase
  return status
}

function publicStatus(record: CoordinatorRecord): CodexAutoRedeemAccountStatus {
  return {
    phase: record.phase,
    ...(record.lastCheckedAt ? { lastCheckedAt: record.lastCheckedAt } : {}),
    ...(record.lastAttemptAt ? { lastAttemptAt: record.lastAttemptAt } : {}),
    ...(record.requestId ? { requestId: record.requestId } : {}),
    ...(record.lastMessage ? { lastMessage: record.lastMessage } : {}),
    ...(record.creditExpiresAt ? { creditExpiresAt: record.creditExpiresAt } : {}),
  }
}

function withoutFields(record: CoordinatorRecord, fields: Array<keyof CoordinatorRecord>) {
  const next = { ...record }
  for (const field of fields) Reflect.deleteProperty(next, field)
  return next
}

async function getStoredSettings(): Promise<StoredSettings> {
  if (isMemoryBackend()) return { ...(memoryWorkspace().settings || defaultSettings) }
  const snapshot = await settingsRef().get()
  return parseSettings(snapshot.data())
}

function publicSettings(settings: StoredSettings): CodexAutoRedeemSettings {
  return { expiryEnabled: settings.expiryEnabled, weeklyExhaustionEnabled: settings.weeklyExhaustionEnabled }
}

export async function getCodexAutoRedeemSettings(): Promise<CodexAutoRedeemSettings> {
  return publicSettings(await getStoredSettings())
}

function changedSettings(current: StoredSettings, input: Partial<CodexAutoRedeemSettings>): StoredSettings {
  const settings = {
    ...current,
    expiryEnabled: input.expiryEnabled ?? current.expiryEnabled,
    weeklyExhaustionEnabled: input.weeklyExhaustionEnabled ?? current.weeklyExhaustionEnabled,
  }
  if (!settings.weeklyExhaustionEnabled) {
    delete settings.weeklyActivationId
    delete settings.weeklyActivatedAt
  } else if (!current.weeklyExhaustionEnabled) {
    settings.weeklyActivationId = crypto.randomUUID()
    settings.weeklyActivatedAt = new Date().toISOString()
  }
  return settings
}

export async function updateCodexAutoRedeemSettings(input: Partial<CodexAutoRedeemSettings>) {
  if (input.expiryEnabled !== undefined && typeof input.expiryEnabled !== "boolean") throw new Error("Expiry setting must be boolean.")
  if (input.weeklyExhaustionEnabled !== undefined && typeof input.weeklyExhaustionEnabled !== "boolean") throw new Error("Weekly exhaustion setting must be boolean.")
  if (isMemoryBackend()) {
    const current = memoryWorkspace().settings || defaultSettings
    const settings = changedSettings(current, input)
    memoryWorkspace().settings = settings
    appendMemoryAudit({ action: "config.update", resource: "oauth", workspaceId: currentWorkspaceId(), result: "success" })
    return publicSettings(settings)
  } else {
    return getSqliteDatabase().runTransaction(async transaction => {
      const snapshot = await transaction.get(settingsRef())
      const current = parseSettings(snapshot.data())
      const settings = changedSettings(current, input)
      transaction.set(settingsRef(), settings)
      appendAuditSqlite(getDatabase(), { action: "config.update", resource: "oauth", workspaceId: currentWorkspaceId(), result: "success" })
      return publicSettings(settings)
    })
  }
}

export async function getCodexAutoRedeemStatus(): Promise<CodexAutoRedeemResponse> {
  const [settings, { accounts: credentials }] = await Promise.all([getCodexAutoRedeemSettings(), listCodexAccounts()])
  const statuses = await mapConcurrent(credentials, 4, async account => {
    const record = await readRecord(resetIdentityKey(account))
    return record ? [account.id, publicStatus(record)] as const : undefined
  })
  return { settings, accounts: Object.fromEntries(statuses.filter((status): status is NonNullable<typeof status> => status !== undefined)) }
}

async function readRecord(accountId: string) {
  if (isMemoryBackend()) {
    const record = memoryWorkspace().accounts.get(accountId)
    return record ? structuredClone(record) : undefined
  }
  const snapshot = await accountRef(accountId).get()
  return parseRecord(snapshot.data())
}

async function mutateRecord(accountId: string, change: (record: CoordinatorRecord | undefined) => CoordinatorRecord | undefined) {
  if (isMemoryBackend()) {
    const workspace = memoryWorkspace()
    const next = change(workspace.accounts.get(accountId))
    if (next) workspace.accounts.set(accountId, structuredClone(next))
    else workspace.accounts.delete(accountId)
    return next ? structuredClone(next) : undefined
  }
  return getSqliteDatabase().runTransaction(async transaction => {
    const reference = accountRef(accountId)
    const snapshot = await transaction.get(reference)
    const next = change(parseRecord(snapshot.data()))
    if (next) transaction.set(reference, next)
    else if (snapshot.exists) transaction.delete(reference)
    return next ? structuredClone(next) : undefined
  })
}

function ageOf(value: string | undefined, now: number) {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? now - parsed : Infinity
}

async function beginCheck(accountId: string) {
  const token = crypto.randomUUID()
  const now = Date.now()
  let acquired = false
  const record = await mutateRecord(accountId, current => {
    if (current?.phase === "unknown" || current?.phase === "pending") return current
    if (current?.phase === "checking" && ageOf(current.checkingAt, now) < staleIntentMs) return current
    if (current?.phase === "deleting" && ageOf(current.deletionStartedAt, now) < staleIntentMs) return current
    const previousPhase: PreviousPhase = current?.phase === "deleting" && current.previousPhase === "unknown"
      ? "unknown"
      : current?.phase === "redeemed" || current?.phase === "deleting" && current.previousPhase === "redeemed" ? "redeemed" : "idle"
    const rest = current ? withoutFields(current, ["deletionToken", "deletionStartedAt", "lockToken", "checkingAt", "previousPhase", "attemptCreditCount", "attemptInventoryKnown"]) : {}
    acquired = true
    return {
      ...rest,
      phase: "checking",
      previousPhase,
      lockToken: token,
      checkingAt: new Date(now).toISOString(),
      lastCheckedAt: new Date(now).toISOString(),
      lastMessage: "Checking Codex reset-credit eligibility.",
    }
  })
  return acquired ? { token, record } : undefined
}

async function setCheckStatus(accountId: string, token: string, message: string, creditExpiresAt?: string) {
  return mutateRecord(accountId, current => {
    if (current?.phase !== "checking" || current.lockToken !== token) return current
    const previousPhase = current.previousPhase
    const rest = withoutFields(current, ["lockToken", "checkingAt", "previousPhase"])
    return {
      ...rest,
      phase: previousPhase === "redeemed" ? "redeemed" : "idle",
      lastCheckedAt: new Date().toISOString(),
      lastMessage: message,
      ...(creditExpiresAt ? { creditExpiresAt } : {}),
    }
  })
}

async function clearRedeemedInventoryGuard(accountId: string, token: string) {
  await mutateRecord(accountId, current => {
    if (current?.phase !== "checking" || current.lockToken !== token || current.previousPhase !== "redeemed") return current
    return withoutFields(current, ["blockedCreditCount", "blockedInventoryKnown"])
  })
}

async function markPending(accountId: string, token: string, requestId: string, creditCount: number, inventoryKnown: boolean, creditExpiresAt?: string) {
  let marked = false
  await mutateRecord(accountId, current => {
    if (current?.phase !== "checking" || current.lockToken !== token) return current
    marked = true
    return {
      ...current,
      phase: "pending",
      requestId,
      lastAttemptAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      lastMessage: "Redemption request sent; waiting for a confirmed outcome.",
      attemptCreditCount: creditCount,
      attemptInventoryKnown: inventoryKnown,
      ...(creditExpiresAt ? { creditExpiresAt } : {}),
    }
  })
  return marked
}

async function finishAttempt(accountId: string, token: string, requestId: string, outcome: "redeemed" | "unknown", message: string) {
  await mutateRecord(accountId, current => {
    if (current?.phase !== "pending" || current.lockToken !== token || current.requestId !== requestId) return current
    const rest = withoutFields(current, ["lockToken", "previousPhase", "attemptCreditCount", "attemptInventoryKnown"])
    return {
      ...rest,
      phase: outcome,
      ...(outcome === "redeemed" && current.attemptCreditCount !== undefined ? { blockedCreditCount: current.attemptCreditCount } : {}),
      ...(outcome === "redeemed" && current.attemptInventoryKnown !== undefined ? { blockedInventoryKnown: current.attemptInventoryKnown } : {}),
      lastCheckedAt: new Date().toISOString(),
      lastMessage: message,
    }
  })
}

async function finishNotSent(accountId: string, token: string, requestId: string, message: string) {
  await mutateRecord(accountId, current => {
    if (current?.phase !== "pending" || current.lockToken !== token || current.requestId !== requestId) return current
    const previousPhase = current.previousPhase
    const rest = withoutFields(current, ["lockToken", "previousPhase", "attemptCreditCount", "attemptInventoryKnown"])
    return { ...rest, phase: previousPhase === "redeemed" ? "redeemed" : "idle", lastCheckedAt: new Date().toISOString(), lastMessage: message }
  })
}

async function markStalePendingUnknown(accountId: string, requestId: string) {
  await mutateRecord(accountId, current => {
    if (current?.phase !== "pending" || current.requestId !== requestId || ageOf(current.lastAttemptAt, Date.now()) < staleIntentMs) return current
    const rest = withoutFields(current, ["lockToken", "previousPhase", "attemptCreditCount", "attemptInventoryKnown"])
    return { ...rest, phase: "unknown", lastCheckedAt: new Date().toISOString(), lastMessage: "The redemption outcome is unknown; automatic retries are blocked." }
  })
}

async function noteUnknownRead(accountId: string, requestId: string, succeeded: boolean) {
  await mutateRecord(accountId, current => {
    if (current?.phase !== "unknown" || current.requestId !== requestId) return current
    return {
      ...current,
      lastCheckedAt: new Date().toISOString(),
      lastMessage: succeeded
        ? "The upstream state was checked; the redemption outcome is still uncertain, so no retry was sent."
        : "The upstream state could not be checked; automatic retries remain blocked.",
    }
  })
}

async function refreshUnknownOutcome(recordId: string, account: ProviderApiKey, record: CoordinatorRecord) {
  let succeeded = false
  try {
    await fetchFreshCodexUsageForReset(account)
    succeeded = true
  } catch {}
  if (record.requestId) await noteUnknownRead(recordId, record.requestId, succeeded)
}

function safeUsageFailure(error: unknown) {
  const status = objectValue(error)?.status
  return typeof status === "number" ? `Codex usage check failed (${status}).` : "Codex usage check failed; it will be retried on the next check."
}

function availableCredits(snapshot: Awaited<ReturnType<typeof fetchFreshCodexUsageForReset>>, now: number) {
  return (snapshot.resetCredits || []).filter(credit => credit.status.toLowerCase() === "available"
    && (!credit.expiresAt || Date.parse(credit.expiresAt) > now))
}

function resetInventoryKnown(snapshot: Awaited<ReturnType<typeof fetchFreshCodexUsageForReset>>) {
  return !snapshot.resetCreditsError && snapshot.resetCredits !== undefined
}

function availableCreditCount(snapshot: Awaited<ReturnType<typeof fetchFreshCodexUsageForReset>>, credits: ReturnType<typeof availableCredits>) {
  return resetInventoryKnown(snapshot) ? credits.length : snapshot.unusedResetCredits ?? 0
}

function ineligibilityMessage(snapshot: Awaited<ReturnType<typeof fetchFreshCodexUsageForReset>>, credits: ReturnType<typeof availableCredits>, settings: CodexAutoRedeemSettings, mode: "manual" | "automatic", now: number) {
  const count = availableCreditCount(snapshot, credits)
  if (!resetInventoryKnown(snapshot) && snapshot.unusedResetCredits === undefined) return "Reset-credit inventory is unavailable."
  if (!count) return "No unused Codex reset credits are available."
  if (!snapshot.weekly) return "Weekly Codex quota status is unavailable."
  if (snapshot.weekly.remainingPercent !== 0) return "Waiting for the weekly Codex quota to be exhausted; redemption is only allowed when eligible."
  if (mode === "manual") return "No Codex reset credit is eligible for redemption."
  if (settings.weeklyExhaustionEnabled) return "A Codex reset credit is eligible for redemption."
  if (!resetInventoryKnown(snapshot)) return "Reset-credit expiry information is unavailable."
  const expiry = credits.flatMap(credit => credit.expiresAt ? [credit.expiresAt] : []).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
  if (!settings.expiryEnabled) return "Automatic redemption is disabled."
  if (!expiry) return "Waiting for a reset credit with a known expiry within 1 hour."
  if (Date.parse(expiry) <= now + expiryWindowMs) return "A Codex reset credit is eligible for redemption."
  return "Waiting until an unused reset credit expires within 1 hour."
}

function errorForIneligibility(snapshot: Awaited<ReturnType<typeof fetchFreshCodexUsageForReset>>, credits: ReturnType<typeof availableCredits>) {
  const count = availableCreditCount(snapshot, credits)
  if (!resetInventoryKnown(snapshot) && snapshot.unusedResetCredits === undefined) return new Error("Codex reset-credit inventory is unavailable.")
  if (!count) return new Error("No unused Codex reset credits are available.")
  if (!snapshot.weekly) return new Error("Weekly Codex quota status is unavailable.")
  if (snapshot.weekly.remainingPercent !== 0) return new Error("The weekly Codex quota must be exhausted before redeeming a reset credit.")
  return new Error("No Codex reset credit is eligible for redemption yet.")
}

async function automaticTriggers(accountId: string, token: string, weeklyRemainingPercent: number | undefined, expiry: string | undefined) {
  const settings = await getStoredSettings()
  const now = Date.now()
  let notBefore: string | undefined
  if (weeklyRemainingPercent !== undefined && settings.weeklyExhaustionEnabled && settings.weeklyActivationId && settings.weeklyActivatedAt) {
    const activationId = settings.weeklyActivationId
    const deadline = Date.parse(settings.weeklyActivatedAt) + pollIntervalMs
    const record = await mutateRecord(accountId, current => {
      if (current?.lockToken !== token || (current.phase !== "checking" && current.phase !== "pending")) return current
      if (current.weeklyActivationId === activationId) return current
      const rest = withoutFields(current, ["weeklyNotBefore"])
      return {
        ...rest,
        weeklyActivationId: activationId,
        ...(weeklyRemainingPercent === 0 && deadline > now ? { weeklyNotBefore: new Date(deadline).toISOString() } : {}),
      }
    })
    notBefore = record?.weeklyActivationId === activationId ? record.weeklyNotBefore : undefined
  }
  const latest = await getStoredSettings()
  const waiting = latest.weeklyActivationId !== settings.weeklyActivationId || notBefore !== undefined && Date.parse(notBefore) > Date.now()
  return {
    settings: latest,
    expiry: latest.expiryEnabled && expiry !== undefined && Date.parse(expiry) > Date.now() && Date.parse(expiry) <= Date.now() + expiryWindowMs,
    weekly: latest.weeklyExhaustionEnabled && weeklyRemainingPercent === 0 && !waiting,
    waiting,
  }
}

async function coordinateCodexReset(account: ProviderApiKey, mode: "manual" | "automatic") {
  if (account.credentialKind !== "codex-oauth") throw new Error("Codex reset credits are only available for connected Codex accounts.")
  const latestAccount = await getCodexCredential(account.providerId, account.id)
  if (!latestAccount || !latestAccount.enabled) {
    if (mode === "manual") throw new Error("Codex account is no longer available.")
    return
  }
  account = latestAccount
  const recordId = resetIdentityKey(account)
  let current = await readRecord(recordId)
  if (current?.phase === "deleting") {
    if (ageOf(current.deletionStartedAt, Date.now()) < staleIntentMs) {
      if (mode === "manual") throw new Error("This Codex account is being removed.")
      return
    }
    if (current.deletionToken) await releaseCodexResetAccountRemoval(account, current.deletionToken)
    current = await readRecord(recordId)
  }
  if (current?.phase === "unknown") {
    await refreshUnknownOutcome(recordId, account, current)
    if (mode === "manual") throw new Error("A previous Codex reset redemption has an uncertain outcome; automatic retries are blocked for this account.")
    return
  }
  if (current?.phase === "pending") {
    if (ageOf(current.lastAttemptAt, Date.now()) < staleIntentMs) {
      if (mode === "manual") throw new Error("A reset redemption is already in progress for this account.")
      return
    }
    if (current.requestId) await markStalePendingUnknown(recordId, current.requestId)
    current = await readRecord(recordId)
    if (current?.phase === "unknown") {
      await refreshUnknownOutcome(recordId, account, current)
      if (mode === "manual") throw new Error("A previous Codex reset redemption has an uncertain outcome; automatic retries are blocked for this account.")
      return
    }
  }
  const settings = await getCodexAutoRedeemSettings()
  if (mode === "automatic" && !settings.expiryEnabled && !settings.weeklyExhaustionEnabled) {
    if (current?.phase === "idle") await mutateRecord(recordId, state => state?.phase === "idle" ? { ...state, lastCheckedAt: new Date().toISOString(), lastMessage: "Automatic redemption is disabled." } : state)
    return
  }

  const claim = await beginCheck(recordId)
  if (!claim) {
    const state = await readRecord(recordId)
    if (mode === "manual") throw new Error(state?.phase === "unknown" ? "A previous Codex reset redemption has an uncertain outcome; automatic retries are blocked for this account." : "A reset redemption or account update is already in progress.")
    return
  }

  try {
    const snapshot = await fetchFreshCodexUsageForReset(account)
    const now = Date.now()
    const credits = availableCredits(snapshot, now)
    const creditCount = availableCreditCount(snapshot, credits)
    const priorRedeemedCount = claim.record?.previousPhase === "redeemed" ? claim.record.blockedCreditCount : undefined
    let inventoryGuardMessage: string | undefined
    if (priorRedeemedCount !== undefined && !resetInventoryKnown(snapshot)) {
      inventoryGuardMessage = "Reset-credit inventory details are unavailable after a confirmed redemption; further redemptions are paused until they can be reconciled."
    } else if (priorRedeemedCount !== undefined && claim.record?.blockedInventoryKnown !== true && credits.length > 0) {
      inventoryGuardMessage = "The previous redemption used count-only inventory; waiting for a complete reset-credit inventory before another redemption."
    } else if (priorRedeemedCount !== undefined && creditCount >= priorRedeemedCount) {
      inventoryGuardMessage = "A previous redemption was confirmed; waiting for Codex to update the reset-credit inventory before another redemption."
    } else if (priorRedeemedCount !== undefined && resetInventoryKnown(snapshot) && credits.length === 0) {
      await clearRedeemedInventoryGuard(recordId, claim.token)
    }
    if (inventoryGuardMessage) {
      await setCheckStatus(recordId, claim.token, inventoryGuardMessage)
      if (mode === "manual") throw new Error(inventoryGuardMessage)
      return
    }
    const weeklyExhausted = snapshot.weekly?.remainingPercent === 0
    const expiry = credits.flatMap(credit => credit.expiresAt ? [credit.expiresAt] : []).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
    const triggers = mode === "automatic" ? await automaticTriggers(recordId, claim.token, snapshot.weekly?.remainingPercent, expiry) : undefined
    const eligible = creditCount > 0 && weeklyExhausted
      && (mode === "manual" || triggers?.expiry || triggers?.weekly)
    if (!eligible) {
      const message = creditCount > 0 && weeklyExhausted && triggers?.waiting
        ? "Weekly quota was already exhausted at activation. Waiting for the 1-minute safety delay; turn off weekly-quota auto-redeem to cancel."
        : ineligibilityMessage(snapshot, credits, triggers?.settings || settings, mode, now)
      await setCheckStatus(recordId, claim.token, message, expiry)
      if (mode === "manual") throw errorForIneligibility(snapshot, credits)
      return
    }

    let releaseExecution: () => void
    try {
      releaseExecution = admitGatewayExecution()
    } catch (error) {
      const message = error instanceof GatewayDrainConflict ? "Reset redemption is temporarily unavailable; retry shortly." : "Reset redemption is temporarily unavailable; it will be retried on the next check."
      await setCheckStatus(recordId, claim.token, message, expiry)
      if (mode === "manual") throw error
      return
    }
    const requestId = crypto.randomUUID()
    try {
      if (!(await markPending(recordId, claim.token, requestId, creditCount, resetInventoryKnown(snapshot), expiry))) return
      const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" }
      let response: Awaited<ReturnType<ResetApiCall>>
      let requestStarted = false
      try {
        response = await auditRemoteOperation(
          { action: "oauth.remote", resource: "oauth", workspaceId: currentWorkspaceId() },
          async () => {
            if (mode === "automatic") {
              const latest = await automaticTriggers(recordId, claim.token, snapshot.weekly?.remainingPercent, expiry)
              if (!latest.expiry && !latest.weekly) throw new Error("Automatic redemption was cancelled or is waiting for its activation safety delay; no request was sent.")
            }
            const input = { method: "POST", url: consumeUrl, headers, data: JSON.stringify({ redeem_request_id: requestId }) }
            if (resetApiCallOverride) {
              requestStarted = true
              return resetApiCallOverride(account, input)
            }
            const upstream = await fetchCodexAccount(
              account,
              input.url,
              { method: input.method, headers: input.headers, body: input.data },
              undefined,
              () => { requestStarted = true },
            )
            return { status: upstream.status, body: await upstream.text() }
          },
          result => result.status >= 200 && result.status < 300,
        )
      } catch (error) {
        if (!requestStarted) {
          await finishNotSent(recordId, claim.token, requestId, "Redemption was cancelled or could not be prepared; no redemption request was sent.")
          throw error
        }
        await finishAttempt(recordId, claim.token, requestId, "unknown", "The redemption outcome is unknown; automatic retries are blocked.")
        await invalidateCodexUsageCache(account.id)
        throw new Error("Codex reset redemption outcome is uncertain; automatic retries are blocked.")
      }
      if (response.status < 200 || response.status >= 300) {
        await finishAttempt(recordId, claim.token, requestId, "unknown", `The redemption outcome is uncertain (HTTP ${response.status}); automatic retries are blocked.`)
        await invalidateCodexUsageCache(account.id)
        throw new Error("Codex reset redemption outcome is uncertain; automatic retries are blocked.")
      }
      await finishAttempt(recordId, claim.token, requestId, "redeemed", "Codex reset credit redeemed.")
      await invalidateCodexUsageCache(account.id, true)
      recordLog("admin.codex.reset.credit.redeemed", { accountId: account.id, redeemRequestId: requestId }, { level: "info" })
      return { ok: true, redeemRequestId: requestId, status: response.status, message: "Codex reset credit redeemed." }
    } finally {
      releaseExecution()
    }
  } catch (error) {
    const state = await readRecord(recordId)
    if (state?.phase === "checking" && state.lockToken === claim.token) {
      await setCheckStatus(recordId, claim.token, safeUsageFailure(error))
    } else if (state?.phase === "pending" && state.lockToken === claim.token && state.requestId) {
      await finishAttempt(recordId, claim.token, state.requestId, "unknown", "The redemption outcome is unknown; automatic retries are blocked.")
    }
    if (mode === "manual") throw error
    return undefined
  }
}

export async function redeemCodexReset(account: ProviderApiKey, confirmation: string) {
  if (!confirmation.toLowerCase().includes("use my codex reset")) throw new Error("Confirmation must contain: use my codex reset")
  return coordinateCodexReset(account, "manual")
}

export async function checkCodexResetAutomatically(account: ProviderApiKey) {
  return coordinateCodexReset(account, "automatic")
}

export async function checkEnabledCodexAccountsAutomatically(accounts: ProviderApiKey[]) {
  await mapConcurrent(accounts.filter(account => account.enabled && account.credentialKind === "codex-oauth"), 4, async account => {
    try { await coordinateCodexReset(account, "automatic") }
    catch { /* Per-account state is durable; one failure must not stop other accounts. */ }
  })
}

export async function getCodexResetAccountStatus(accountId: string) {
  const { accounts } = await listCodexAccounts()
  const account = accounts.find(entry => entry.id === accountId)
  if (!account) return undefined
  const record = await readRecord(resetIdentityKey(account))
  return record ? publicStatus(record) : undefined
}

/** Reserve account removal against new reset POSTs and wait out an active attempt. */
export async function reserveCodexResetAccountRemoval(account: ProviderApiKey) {
  const recordId = resetIdentityKey(account)
  const token = crypto.randomUUID()
  let acquired = false
  const now = Date.now()
  await mutateRecord(recordId, current => {
    const active = current?.phase === "checking" && ageOf(current.checkingAt, now) < staleIntentMs
      || current?.phase === "pending" && ageOf(current.lastAttemptAt, now) < staleIntentMs
      || current?.phase === "deleting" && ageOf(current.deletionStartedAt, now) < staleIntentMs
    if (active) return current
    acquired = true
    const previousPhase: PreviousPhase = current?.phase === "unknown"
      || current?.phase === "pending"
      || current?.phase === "deleting" && current.previousPhase === "unknown"
      ? "unknown"
      : current?.phase === "redeemed" || current?.phase === "deleting" && current.previousPhase === "redeemed"
        ? "redeemed"
        : current?.phase === "checking" && current.previousPhase ? current.previousPhase : "idle"
    const rest = current ? withoutFields(current, ["lockToken", "checkingAt", "previousPhase", "deletionToken", "deletionStartedAt", "attemptCreditCount", "attemptInventoryKnown"]) : {}
    return {
      ...rest,
      phase: "deleting",
      previousPhase,
      deletionToken: token,
      deletionStartedAt: new Date(now).toISOString(),
      lastMessage: previousPhase === "unknown"
        ? "Account removal is in progress; the previous redemption outcome remains uncertain."
        : "Codex account removal is in progress.",
    }
  })
  if (!acquired) throw new Error("A Codex reset redemption is in progress. Try removing the account again shortly.")
  return token
}

export async function releaseCodexResetAccountRemoval(account: ProviderApiKey, token: string) {
  const recordId = resetIdentityKey(account)
  await mutateRecord(recordId, current => {
    if (current?.phase !== "deleting" || current.deletionToken !== token) return current
    const previousPhase = current.previousPhase
    const rest = withoutFields(current, ["deletionToken", "deletionStartedAt", "previousPhase"])
    return {
      ...rest,
      phase: previousPhase || "idle",
      lastMessage: previousPhase === "unknown"
        ? "The redemption outcome remains uncertain; automatic retries are blocked."
        : previousPhase === "redeemed" ? "The previous Codex reset redemption was confirmed." : "Account removal did not finish; reset checks will resume.",
    }
  })
}

export async function completeCodexResetAccountRemoval(account: ProviderApiKey, token: string) {
  const recordId = resetIdentityKey(account)
  await mutateRecord(recordId, current => {
    if (current?.phase !== "deleting" || current.deletionToken !== token) return current
    const previousPhase = current.previousPhase
    if (previousPhase !== "unknown" && previousPhase !== "redeemed") return undefined
    const rest = withoutFields(current, ["deletionToken", "deletionStartedAt", "previousPhase", "lockToken", "checkingAt"])
    return {
      ...rest,
      phase: previousPhase,
      lastMessage: previousPhase === "unknown"
        ? "The redemption outcome remains uncertain; automatic retries are blocked."
        : "The previous Codex reset redemption was confirmed; waiting for inventory reconciliation.",
    }
  })
}

export function cleanupCodexResetWorkspace(workspaceId: string) {
  resetMemory().delete(workspaceId)
  const state = scheduler()
  const wakeup = state.wakeups.get(workspaceId)
  if (wakeup) clearTimeout(wakeup)
  state.wakeups.delete(workspaceId)
}

async function checkWorkspaceCodexResets() {
  const { accounts } = await listCodexAccounts()
  await checkEnabledCodexAccountsAutomatically(accounts)
}

function scheduleWorkspaceCheck(workspace: WorkspaceContext) {
  const state = scheduler()
  if (!state.active) return Promise.resolve()
  const existing = state.checks.get(workspace.id)
  if (existing) {
    state.queued.add(workspace.id)
    return existing
  }
  const check = (): Promise<void> => Promise.resolve()
    .then(() => runInWorkspace(workspace, checkWorkspaceCodexResets))
    .catch(() => undefined)
    .then(() => {
      // Re-run after an in-flight check if a settings change arrived meanwhile.
      if (state.queued.delete(workspace.id)) return check()
    })
  const task = check().finally(() => { state.checks.delete(workspace.id) })
  state.checks.set(workspace.id, task)
  return task
}

/** Wake immediately after a settings change, then at the activation grace deadline. */
export async function requestCodexResetWorkspaceCheck() {
  const state = scheduler()
  if (!state.active) return
  const workspace = workspaceContext()
  const previousWakeup = state.wakeups.get(workspace.id)
  if (previousWakeup) clearTimeout(previousWakeup)
  state.wakeups.delete(workspace.id)
  const settings = await getStoredSettings()
  if (!state.active) return
  void scheduleWorkspaceCheck(workspace)
  const deadline = settings.weeklyExhaustionEnabled && settings.weeklyActivatedAt ? Date.parse(settings.weeklyActivatedAt) + pollIntervalMs : NaN
  if (deadline > Date.now()) {
    const timer = setTimeout(() => {
      if (state.wakeups.get(workspace.id) !== timer) return
      state.wakeups.delete(workspace.id)
      void scheduleWorkspaceCheck(workspace)
    }, deadline - Date.now())
    timer.unref?.()
    state.wakeups.set(workspace.id, timer)
  }
}

async function pollWorkspaceCodexResets() {
  const workspaces = (await listWorkspaces()).filter(workspace => workspace.status === "active")
  await mapConcurrent(workspaces, 4, async workspace => {
    try {
      await scheduleWorkspaceCheck({ id: workspace.id, storageMode: workspace.storageMode || "scoped" })
    } catch {
      // Deletion closes workspace admission before its cleanup participant runs.
    }
  })
}

function schedulePoll() {
  const state = scheduler()
  if (!state.active || state.running) return state.running
  const task = pollWorkspaceCodexResets().catch(() => undefined).finally(() => {
    if (state.running === task) state.running = undefined
  })
  state.running = task
  return task
}

export function startCodexResetAutomation() {
  const state = scheduler()
  if (state.timer) return
  state.active = true
  void schedulePoll()
  state.timer = setInterval(() => { void schedulePoll() }, pollIntervalMs)
  state.timer.unref?.()
}

export async function stopCodexResetAutomation() {
  const state = scheduler()
  state.active = false
  if (state.timer) clearInterval(state.timer)
  state.timer = undefined
  for (const timer of state.wakeups.values()) clearTimeout(timer)
  state.wakeups.clear()
  await Promise.all([state.running, ...state.checks.values()])
}

export function setCodexResetApiCallForTests(apiCall?: ResetApiCall) {
  resetApiCallOverride = apiCall
}

export function resetCodexResetCoordinatorForTests() {
  resetMemory().clear()
  resetApiCallOverride = undefined
}
