import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { closeLocalDatabase, getSqliteDatabase, queryLocalUsageRange } from "./local-db"
import { getBudgetAdmission, getBudgetRows, getDashboardPayload, getOverviewPayload, recordUsageEvent, resetAnalyticsForTests, updateBudgetWindow, upsertBudget } from "./analytics"
import { runInWorkspace } from "./workspace/context"
import { _resetMemoryBackend, upsertModel, upsertProvider } from "@/server/store"
import { savePricingVersion, syncModelPricingGroups } from "./model-pricing"
import { readMemoryUsageRange, usageRangeSegments } from "./usage-range"
import { usageCalendarBucket } from "./usage-projection"
import { migrateUsageProjection } from "../../scripts/migrations/usage-projection-store"
import type { UsageEvent } from "./types"

let directory: string
let file: string
beforeEach(async () => {
  await closeLocalDatabase()
  directory = mkdtempSync("/tmp/opencode/usage-range-")
  file = join(directory, "test.sqlite")
  Object.assign(process.env, { SQLITE_PATH: file, RAWROUTE_DATA_DIR: directory, DATABASE_COLLECTION_PREFIX: "rawroute", STORAGE_BACKEND: "sqlite", NODE_ENV: "development", TIMEZONE: "UTC" })
  _resetMemoryBackend(); resetAnalyticsForTests()
})
afterEach(async () => { jest.useRealTimers(); await closeLocalDatabase(); rmSync(directory, { recursive: true, force: true }) })
const scoped = <T>(id: string, fn: () => T) => runInWorkspace({ id, storageMode: "scoped" }, fn)
function event(id: string, completedAt: string, extra: Partial<UsageEvent> = {}): UsageEvent {
  return { id, gatewayKeyId: "key", gatewayModelId: "coverage/model", protocol: "openai-chat", startedAt: completedAt, completedAt, status: 200, durationMs: 100, inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 1, totalTokens: 12, costMicros: 20, pricingConfidence: "exact", usageAvailable: true, usageCompleteness: "complete", ...extra }
}
function source(db: Database, collection: string, id: string, data: object) {
  db.run("INSERT INTO rawroute_documents(path,collection_path,document_id,data) VALUES(?,?,?,?)", [`${collection}/${id}`,collection,id,JSON.stringify(data)])
}
function historicalFixture() {
  const db = new Database(file)
  db.run("CREATE TABLE rawroute_documents(path TEXT PRIMARY KEY,collection_path TEXT NOT NULL,document_id TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
  return db
}

test("range partition has disjoint daily interiors, hourly edges and at most two raw partial hours", () => {
  for (const [from,to] of [
    ["2026-10-01T00:15:00.000Z","2026-10-01T01:45:00.000Z"],
    ["2026-10-01T00:15:00.000Z","2026-10-30T10:45:00.000Z"],
    ["2026-10-01T00:15:00.000Z","2026-10-01T00:45:00.000Z"],
  ]) {
    const segments = usageRangeSegments(from!,to!)
    expect(segments[0]?.from).toBe(from)
    expect(segments.at(-1)?.to).toBe(to)
    expect(segments.filter(segment => segment.granularity === "raw").length).toBeLessThanOrEqual(2)
    for (let index=0;index<segments.length;index++) {
      const segment=segments[index]!
      if (index) expect(segments[index-1]!.to).toBe(segment.from)
      if (segment.granularity === "raw") expect(segment.to <= usageCalendarBucket(segment.from,"hourly").bucketEnd).toBe(true)
    }
  }
})

test("SQLite and memory agree on exact partial-hour, daily interior, status, token coverage and weighted duration measures", async () => {
  const from="2026-10-01T00:15:00.000Z"; const to="2026-10-03T01:45:00.000Z"
  const attempts = [
    event("before","2026-10-01T00:14:59.999Z"),
    event("start",from,{durationMs:0}),
    event("hour","2026-10-01T01:00:00.000Z",{status:500,durationMs:700,costMicros:90}),
    event("daily","2026-10-02T10:00:00.000Z",{gatewayModelId:"second",durationMs:300}),
    event("partial","2026-10-03T01:30:00.000Z",{inputTokens:7,outputTokens:0,totalTokens:7,usageCompleteness:"partial"}),
    event("end",to),
  ]
  const results: Array<Awaited<ReturnType<typeof queryLocalUsageRange>>> = []
  for (const backend of ["memory","sqlite"] as const) {
    process.env.STORAGE_BACKEND=backend
    await scoped("parity",async()=>{
      for (const attempt of attempts) await recordUsageEvent(attempt,null)
      if (backend === "sqlite") results.push(await queryLocalUsageRange("parity",from,to))
      else {
        const state=globalThis.__rawrouteAnalyticsMemory!.get("parity")!
        results.push(readMemoryUsageRange("parity",state.projection,state.events,state.eventsByHour,from,to))
      }
    })
  }
  expect(results[0]!.totals).toEqual(results[1]!.totals)
  expect(results[1]!.totals).toMatchObject({requests:4,costMicros:150,successfulCostMicros:60,failedRequests:1,statusCoveredRequests:4,durationCount:4,durationSumMs:1100,tokenCoveredRequests:3})
  expect(results[1]!.stages.rawRows).toBe(2)
  expect(results[1]!.stages.bucketRows).toBeGreaterThan(0)
  expect(results[1]!.coverage).toMatchObject({partial:true,excludedSources:0,financialUnavailable:false})
  const aligned=await queryLocalUsageRange("parity","2026-10-02T00:00:00.000Z","2026-10-03T00:00:00.000Z")
  expect(aligned.stages.rawRows).toBe(0)
  expect(aligned.totals.requests).toBe(1)
})

for (const [zone,from,to,hours] of [
  ["America/New_York","2026-03-08T05:00:00.000Z","2026-03-09T04:00:00.000Z",23],
  ["America/New_York","2026-11-01T04:00:00.000Z","2026-11-02T05:00:00.000Z",25],
  ["Asia/Kathmandu","2026-10-12T18:15:00.000Z","2026-10-13T18:15:00.000Z",24],
] as const) test(`${zone}: canonical hour/day boundaries preserve ${hours}-hour calendar days and quiet chart grids`, async()=>{
  process.env.TIMEZONE=zone
  const day=usageCalendarBucket(from,"daily")
  expect(day).toEqual({bucketStart:from,bucketEnd:to})
  await scoped("calendar",async()=>{
    await recordUsageEvent(event("first",new Date(Date.parse(from)+30*60_000).toISOString()),null)
    await recordUsageEvent(event("last",new Date(Date.parse(to)-1).toISOString()),null)
    const range=await queryLocalUsageRange("calendar",from,to)
    expect(range.totals.requests).toBe(2)
    expect(range.stages.rawRows).toBe(0)
    const date=zone==="Asia/Kathmandu"?"2026-10-13":hours===23?"2026-03-08":"2026-11-01"
    const payload=await getDashboardPayload({preset:"custom",from:date,to:date,granularity:"hourly"})
    expect(payload.trend).toHaveLength(hours)
    expect(payload.summary.requests).toBe(2)
    expect(new Set(payload.trend.map(point=>point.bucketStart)).size).toBe(hours)
    expect(payload.range.from).toBe(from)
    expect(Date.parse(payload.range.to)+1).toBe(Date.parse(to))
  })
})

test("canonical history is counted once at actual resolution; partial sources are unavailable, never prorated or invented as hourly data", async()=>{
  const db=historicalFixture()
  const base={gatewayKeyId:"key",gatewayModelId:"coverage/model",requests:2,inputTokens:20,outputTokens:4,cacheReadTokens:6,cacheCreationTokens:2,totalTokens:24,costMicros:40,successfulCostMicros:40,statusCoveredRequests:2,failedRequests:0,pricedRequests:2,unpricedRequests:0,backfillSource:"ccs-usage-v2"}
  source(db,"rawroute_workspaces/history/usageRollups","hour",{...base,granularity:"hourly",bucketStart:"2026-10-01T12:00:00.000Z"})
  source(db,"rawroute_workspaces/history/usageRollups","day",{...base,granularity:"daily",bucketStart:"2026-10-02T00:00:00.000Z"})
  source(db,"rawroute_workspaces/history/usageEvents","runtime",event("runtime","2026-10-01T13:00:00.000Z"))
  db.close();migrateUsageProjection(file,{timeZone:"UTC",apply:true,writersStopped:true})
  const full=await queryLocalUsageRange("history","2026-10-01T00:00:00.000Z","2026-10-03T00:00:00.000Z")
  expect(full.totals).toMatchObject({requests:5,costMicros:100,successfulCostMicros:100})
  expect(full.financialUnavailableKeys.size).toBe(0)
  const partial=await queryLocalUsageRange("history","2026-10-01T12:30:00.000Z","2026-10-01T14:00:00.000Z")
  expect(partial.totals).toMatchObject({requests:1,costMicros:20})
  expect(partial.financialUnavailableKeys.has("key")).toBe(true)
  await scoped("history",async()=>{
    const payload=await getDashboardPayload({preset:"custom",from:"2026-10-02",to:"2026-10-02",granularity:"hourly"})
    expect(payload.summary.requests).toBe(2)
    expect(payload.trend).toEqual([])
    expect(payload.coverage).toMatchObject({partial:true,unsupportedTrendSources:1})
  })
})

test("unknown historical finance fails admission only for the affected key/window and surfaces null credit", async()=>{
  jest.useFakeTimers();jest.setSystemTime(new Date("2026-10-13T18:00:00.000Z"))
  const db=historicalFixture()
  source(db,"rawroute_workspaces/financial/usageRollups","unknown",{granularity:"daily",bucketStart:"2026-10-13T00:00:00.000Z",gatewayKeyId:"a",gatewayModelId:"coverage/model",requests:2,inputTokens:20,outputTokens:4,cacheReadTokens:0,cacheCreationTokens:0,totalTokens:24,costMicros:50,backfillSource:"ccs-usage-v2"})
  db.close();migrateUsageProjection(file,{timeZone:"UTC",apply:true,writersStopped:true})
  await scoped("financial",async()=>{
    for(const id of ["a","b"]) await getSqliteDatabase().collection("rawroute_workspaces/financial/apiKeys").doc(id).set({name:id,key:`offline-${id}`,createdAt:"2026-10-01T00:00:00.000Z"})
    const provider=await upsertProvider({name:"Coverage",prefix:"coverage",baseUrl:"https://offline.invalid",protocol:"openai-chat",authType:"none",headers:{},enabled:true})
    const model=await upsertModel(provider.id,{id:"model",name:"Model",gatewayModelId:"coverage/model",upstreamModel:"model"})
    const group=(await syncModelPricingGroups()).find(entry=>entry.memberModelIds.includes(model.id))!
    await savePricingVersion({groupId:group.id,mode:"new",rates:{inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:1_000_000,cacheReadMicrosPerMillion:0,cacheCreationMicrosPerMillion:0},contextTiers:[]})
    await updateBudgetWindow({anchor:"custom",start:"2026-10-01T00:00:00.000Z",end:"2026-11-01T00:00:00.000Z"})
    for(const id of ["a","b"]) await upsertBudget({apiKeyId:id,weeklyLimitMicros:1000,enabled:true})
    await recordUsageEvent(event("b","2026-10-13T12:00:00.000Z",{gatewayKeyId:"b",costMicros:35}),{usageStartAt:"2026-01-01T00:00:00.000Z",windowEnd:"2026-01-02T00:00:00.000Z"})
    const rows=await getBudgetRows()
    expect(rows.find(row=>row.apiKeyId==="a")).toMatchObject({spentMicros:null,usageAvailable:false})
    expect(rows.find(row=>row.apiKeyId==="b")?.spentMicros).toBe(35)
    await expect(getBudgetAdmission("a","coverage/model",model.id)).rejects.toMatchObject({status:503})
    expect((await getBudgetAdmission("b","coverage/model",model.id))?.spentMicros).toBe(35)
    const overview=await getOverviewPayload({from:"2026-10-13T00:00:00.000Z",to:"2026-10-14T00:00:00.000Z"})
    expect(overview.overview.budgets.find(row=>row.id==="a")?.spentMicros).toBeNull()
    await updateBudgetWindow({anchor:"custom",start:"2026-10-14T00:00:00.000Z",end:"2026-11-01T00:00:00.000Z"})
    expect((await getBudgetAdmission("a","coverage/model",model.id))?.spentMicros).toBe(0)
  })
  await scoped("other",async()=>expect((await getDashboardPayload({preset:"all"},true)).summary.requests).toBe(0))
})

test("historical midnight folds retain disjoint daily segments and exact ranges", async () => {
  process.env.TIMEZONE = "America/Goose_Bay"
  const attempts = ["2010-11-07T02:59:00.000Z", "2010-11-07T03:00:30.000Z", "2010-11-07T03:15:00.000Z", "2010-11-07T04:00:00.000Z"]
  await scoped("midnight-fold", async () => {
    for (const [index, at] of attempts.entries()) {
      const day = usageCalendarBucket(at, "daily")
      expect(day.bucketStart <= at && at < day.bucketEnd).toBe(true)
      await recordUsageEvent(event(`fold-${index}`, at), null)
    }
    const day = usageCalendarBucket(attempts[2]!, "daily")
    expect(day).toEqual({ bucketStart: "2010-11-07T03:01:00.000Z", bucketEnd: "2010-11-07T04:00:00.000Z" })
    for (const [from, to, requests] of [
      ["2010-11-06T03:00:00.000Z", "2010-11-08T04:00:00.000Z", 4],
      ["2010-11-07T03:00:00.000Z", "2010-11-07T04:00:00.000Z", 2],
      ["2010-11-07T03:01:00.000Z", "2010-11-07T04:00:00.000Z", 1],
    ] as const) expect((await queryLocalUsageRange("midnight-fold", from, to)).totals.requests).toBe(requests)
    const overview = await getOverviewPayload({ from: "2010-11-06T03:00:00.000Z", to: "2010-11-08T04:00:00.000Z" })
    expect(overview.summary.requests).toBe(4)
    expect(overview.trend.reduce((sum, row) => sum + row.requests, 0)).toBe(4)
    expect(new Set(overview.trend.map(row => row.bucketStart)).size).toBe(overview.trend.length)
  })
})
