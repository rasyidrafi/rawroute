import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import type { AnalyticsCoverage } from "@/lib/types"
import { EmptyState } from "@/components/ui/empty-state"
import { DatabaseIcon } from "lucide-react"

export function UsageEmptyState({ partial }: { partial?: boolean }) {
  return <EmptyState title={partial ? "Usage unavailable" : "No usage yet"} description={partial ? "Coverage is incomplete for this range; no complete usage total can be shown." : "No gateway activity was recorded for this range."} icon={DatabaseIcon} />
}

export function UsageCoverageNotice({ coverage, requests }: { coverage?: AnalyticsCoverage; requests: number }) {
  if (!coverage?.partial) return null
  const missing = [
    coverage.excludedSources > 0 && "historical sources",
    coverage.tokenCoveredRequests < requests && "token usage",
    coverage.statusCoveredRequests < requests && "status",
    coverage.costCoveredRequests < requests && "spend",
    coverage.modelCoveredRequests < requests && "model attribution",
    coverage.keyCoveredRequests < requests && "key attribution",
    coverage.durationCount < requests && "durations",
    coverage.unsupportedTrendSources > 0 && "trend resolution",
  ].filter(Boolean).join(", ")
  return <Alert>
    <AlertTitle>Partial analytics coverage</AlertTitle>
    <AlertDescription>{missing ? `Incomplete ${missing}. ` : ""}Totals show only known recorded amounts; unavailable data is not zero usage.{coverage.financialUnavailable ? " Budget usage is unavailable for affected keys and windows." : ""}</AlertDescription>
  </Alert>
}
