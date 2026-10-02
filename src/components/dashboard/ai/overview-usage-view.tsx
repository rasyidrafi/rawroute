import { useMemo, useState } from "react"
import type { DateRange } from "react-day-picker"

import { DashboardPage } from "@/components/dashboard/page-layout"
import { DEFAULT_DASHBOARD_QUERY } from "@/lib/dashboard-defaults"
import type { DashboardQuery } from "@/lib/types"
import { calendarDateFromInstant } from "@/lib/timezone"
import { createOverviewUsageData } from "./overview-usage-data"
import { UsageOverview } from "./usage-overview"
import { DashboardTrend, ModelMix, TopKeys, UsageTable } from "./usage-panels"
import { UsageSummary } from "./usage-summary"

export function OverviewUsageView() {
  const [query, setQuery] = useState<DashboardQuery>(DEFAULT_DASHBOARD_QUERY)
  const [customRange, setCustomRange] = useState<DateRange>()
  const [now, setNow] = useState(() => new Date())
  const dashboard = useMemo(() => createOverviewUsageData(query, customRange, now), [query, customRange, now])
  const selectedRange = query.preset === "custom" ? customRange : {
    from: calendarDateFromInstant(dashboard.range.from), to: calendarDateFromInstant(dashboard.range.to),
  }

  function setPreset(preset: DashboardQuery["preset"]) {
    setQuery(current => ({ ...current, preset }))
    if (preset !== "custom") setCustomRange(undefined)
  }

  function handleRangeChange(range: DateRange | undefined) {
    setCustomRange(range)
    setQuery(current => ({ ...current, preset: "custom" }))
  }

  return <DashboardPage spacing="compact">
    <UsageOverview dashboard={dashboard} loading={false} preset={query.preset} setPreset={setPreset} granularity={query.granularity ?? "auto"} setGranularity={granularity => setQuery(current => ({ ...current, granularity }))} selectedRange={selectedRange} onRangeChange={handleRangeChange} onRefresh={() => setNow(new Date())} />
    <UsageSummary dashboard={dashboard} />
    <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">
      <DashboardTrend dashboard={dashboard} refreshing={false} />
      <TopKeys keys={dashboard.keys} refreshing={false} />
    </div>
    <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
      <UsageTable keys={dashboard.keys} refreshing={false} />
      <ModelMix models={dashboard.models} refreshing={false} />
    </div>
  </DashboardPage>
}
