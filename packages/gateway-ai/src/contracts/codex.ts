export interface CodexQuotaWindow { usedPercent: number; remainingPercent: number; resetAt?: string }
export interface CodexResetCredit { id: string; status: string; grantedAt?: string; expiresAt?: string }
export interface CodexUsageSnapshot {
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
export type CodexDiscoveryStatus = { attemptedAt: string; succeededAt?: string; error?: string; added: number; skipped: number }
