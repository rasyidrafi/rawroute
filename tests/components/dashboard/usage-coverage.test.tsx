import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { UsageSummary } from "@/components/dashboard/ai/usage-summary"
import { BudgetUsageCard } from "@/components/dashboard/ai/overview-cards"
import type { AnalyticsCoverage, DashboardPayload } from "@/lib/types"

const complete:AnalyticsCoverage={partial:false,excludedSources:0,tokenCoveredRequests:0,statusCoveredRequests:0,costCoveredRequests:0,modelCoveredRequests:0,keyCoveredRequests:0,durationCount:0,financialUnavailable:false,unsupportedTrendSources:0}
test("unsupported-only summaries and budget balances render unavailable, not zero totals or remaining credit",()=>{
  const payload:DashboardPayload={generatedAt:"2026-10-13T00:00:00.000Z",range:{label:"Range",from:"2026-10-13T00:00:00.000Z",to:"2026-10-14T00:00:00.000Z",granularity:"daily"},summary:{requests:0,tokens:0,costMicros:0,activeKeys:0,pricedRequests:0,unpricedRequests:0},trend:[],keys:[],models:[],freshness:{source:"sqlite",lastEventAt:null},pricingConfidence:{pricedRequests:0,unpricedRequests:0},coverage:{...complete,partial:true,excludedSources:1,financialUnavailable:true}}
  const html=renderToStaticMarkup(<UsageSummary dashboard={payload}/>)
  expect(html.match(/Unavailable/g)).toHaveLength(4)
  const budget=renderToStaticMarkup(<MemoryRouter><BudgetUsageCard data={{inputTokens:0,cacheReadTokens:0,failedRequests:0,statusCoveredRequests:0,durationCount:0,durationSumMs:0,budgetWindow:null,budgets:[{id:"key",name:"Key",enabled:true,limitMicros:1000,spentMicros:null,usageAvailable:false}]}}/></MemoryRouter>)
  expect(budget).toContain("Unavailable")
  expect(budget).not.toContain('role="progressbar"')
})
