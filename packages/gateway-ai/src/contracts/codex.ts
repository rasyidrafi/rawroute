export interface CodexQuotaWindow { usedPercent: number; remainingPercent: number; resetAt?: string }
export interface CodexResetCredit { id: string; status: string; grantedAt?: string; expiresAt?: string }
export interface CodexUsageSnapshot {
  planType?: string
  resetCredits?: CodexResetCredit[]
  resetCreditsError?: string
  fiveHour: CodexQuotaWindow | null
  weekly: CodexQuotaWindow | null
  unusedResetCredits?: number
}
export interface CodexUsageResult extends CodexUsageSnapshot {
  fetchedAt: string | null
  stale: boolean
  error?: string
  reauthRequired?: boolean
}
export interface CodexAutoRedeemSettings {
  expiryEnabled: boolean
  weeklyExhaustionEnabled: boolean
}
export type CodexResetCoordinatorPhase = "idle" | "checking" | "pending" | "unknown" | "redeemed" | "deleting"
export interface CodexAutoRedeemAccountStatus {
  phase: CodexResetCoordinatorPhase
  lastCheckedAt?: string
  lastAttemptAt?: string
  requestId?: string
  lastMessage?: string
  creditExpiresAt?: string
}
export type CodexAutoRedeemResponse = {
  settings: CodexAutoRedeemSettings
  accounts: Record<string, CodexAutoRedeemAccountStatus>
}
export type CodexDiscoveryStatus = { attemptedAt: string; succeededAt?: string; error?: string; added: number; skipped: number }
