import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { maintainCanonicalUsage } from "../../scripts/migrations/usage-maintenance"
import { migrateUsageProjection } from "../../scripts/migrations/usage-projection-store"
import { predictMissingUsageCosts } from "../../scripts/predict-missing-usage-cost"
import { normalizeUsageMetrics } from "../../packages/gateway-ai/src/server/usage-metrics"
import type { UsageEvent } from "../../packages/gateway-ai/src/contracts/domain"

let directory=""
let file:string
const from="2026-10-13T00:00:00.000Z";const to="2026-10-14T00:00:00.000Z"
const checksum=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex")
function event(id:string,costMicros:number):UsageEvent {
  return {id,gatewayKeyId:"key",gatewayModelId:"synthetic/model",protocol:"openai-chat",startedAt:"2026-10-13T12:00:00.000Z",completedAt:"2026-10-13T12:00:00.000Z",status:200,durationMs:10,...normalizeUsageMetrics({input:10,output:2}),costMicros,pricingConfidence:"exact"}
}
beforeEach(()=>{
  directory=""
  directory=mkdtempSync(join(tmpdir(),"usage-maintenance-"));file=join(directory,"test.sqlite")
  process.env.TIMEZONE="UTC"
  const db=new Database(file)
  db.run("CREATE TABLE rawroute_documents(path TEXT PRIMARY KEY,collection_path TEXT NOT NULL,document_id TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)")
  const put=(collection:string,id:string,data:object)=>db.run("INSERT INTO rawroute_documents(path,collection_path,document_id,data)VALUES(?,?,?,?)",[`${collection}/${id}`,collection,id,JSON.stringify(data)])
  for(const [index,cost]of[20,40,60].entries())put("rawroute_workspaces/default/usageEvents",`sample-${index}`,event(`sample-${index}`,cost))
  put("rawroute_usage_events","sample-0",event("sample-0",20))
  put("rawroute_workspaces/default/usageEvents","missing",{...event("missing",0),...normalizeUsageMetrics(undefined),pricingConfidence:"unpriced"})
  db.close();migrateUsageProjection(file,{timeZone:"UTC",apply:true,writersStopped:true})
})
afterEach(()=>{if(directory)rmSync(directory,{recursive:true,force:true})})
const plan:Parameters<typeof maintainCanonicalUsage>[2]=events=>predictMissingUsageCosts(events,from,to)

test("canonical empirical repair is readonly by default, excludes flat duplicates, atomically rebuilds and is idempotent",()=>{
  const before=checksum(file)
  const dry=maintainCanonicalUsage(file,{timeZone:"UTC"},events=>{
    expect(events).toHaveLength(4)
    const repairs=plan(events)
    expect(repairs[0]?.event).toMatchObject({costMicros:30,pricingConfidence:"assumed",costSource:"empirical",predictionSampleCount:3,usageCompleteness:"missing"})
    return repairs
  })
  expect(dry).toMatchObject({candidates:1,applied:false})
  expect(checksum(file)).toBe(before)
  expect(()=>maintainCanonicalUsage(file,{timeZone:"UTC",apply:true},plan)).toThrow("Stop all writers")
  const result=maintainCanonicalUsage(file,{timeZone:"UTC",apply:true,writersStopped:true},plan)
  expect(result.applied).toBe(true)
  expect(existsSync(`${file}.before-usage-repair`)).toBe(true)
  const db=new Database(file)
  expect(db.query("SELECT requests,costMicros,successfulCostMicros,tokenCoveredRequests FROM usage_buckets WHERE granularity='daily'").get()).toEqual({requests:4,costMicros:150,successfulCostMicros:150,tokenCoveredRequests:3})
  expect(JSON.parse(db.query<{data:string},[]>("SELECT data FROM rawroute_documents WHERE document_id='missing'").get()!.data)).toMatchObject({costMicros:30,costSource:"empirical"})
  db.close()
  expect(maintainCanonicalUsage(file,{timeZone:"UTC",apply:true,writersStopped:true},plan)).toMatchObject({candidates:0,applied:false})
  expect(migrateUsageProjection(file,{timeZone:"UTC",apply:true,writersStopped:true}).unchanged).toBe(true)
})

test("repair refuses stale configuration and active writers; projection failure rolls raw repairs back",()=>{
  expect(()=>maintainCanonicalUsage("",{timeZone:"UTC"},plan)).toThrow("explicit")
  expect(()=>maintainCanonicalUsage(file,{timeZone:"America/New_York"},plan)).toThrow("mismatch")
  const db=new Database(file)
  const before=db.query("SELECT * FROM rawroute_documents ORDER BY path").all()
  db.run("BEGIN IMMEDIATE")
  expect(()=>maintainCanonicalUsage(file,{timeZone:"UTC",apply:true,writersStopped:true},plan)).toThrow()
  db.run("ROLLBACK")
  db.run("CREATE TRIGGER reject_repair BEFORE INSERT ON usage_buckets BEGIN SELECT RAISE(ABORT,'repair failure'); END")
  db.close()
  expect(()=>maintainCanonicalUsage(file,{timeZone:"UTC",apply:true,writersStopped:true},plan)).toThrow("repair failure")
  const after=new Database(file)
  expect(after.query("SELECT * FROM rawroute_documents ORDER BY path").all()).toEqual(before)
  expect(after.query("SELECT costMicros FROM usage_buckets WHERE granularity='daily'").get()).toEqual({costMicros:120})
  after.close()
  expect(existsSync(`${file}.before-usage-repair`)).toBe(true)
})
