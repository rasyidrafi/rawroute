import { ArrowLeftIcon, ActivityIcon, CoinsIcon, KeyRoundIcon, LayersIcon, WalletCardsIcon } from "lucide-react"
import { Link, useLocation, useParams } from "react-router"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { pagePaths } from "@/lib/dashboard/routes"

// Deliberately static design fixtures. No key credentials or usage APIs are read.
const models = [
  { name: "GPT-6.1 Sol", requests: "1,520", tokens: "128M", cost: "$60.84", share: 69.3 },
  { name: "GPT-6 Astra", requests: "680", tokens: "62M", cost: "$22.37", share: 25.5 },
  { name: "GPT-6 Luna", requests: "300", tokens: "20M", cost: "$4.56", share: 5.2 },
]
const days = ["15 Oct", "16 Oct", "17 Oct", "18 Oct", "19 Oct", "20 Oct", "21 Oct"]
const costs = [8.12, 14.5, 10.35, 18.7, 12.4, 16.5, 7.2]
const attempts = [
  { id: "sample-1", model: "GPT-6.1 Sol", tokens: "84k", cost: "$0.04", time: "14:58" },
  { id: "sample-2", model: "GPT-6 Astra", tokens: "52k", cost: "$0.08", time: "14:55" },
  { id: "sample-3", model: "GPT-6.1 Sol", tokens: "96k", cost: "$0.05", time: "14:52" },
  { id: "sample-4", model: "GPT-6 Luna", tokens: "38k", cost: "$0.01", time: "14:49" },
]

export function KeyUsageView() {
  const { keyId } = useParams()
  const { state } = useLocation()
  const label = typeof state?.keyLabel === "string" ? state.keyLabel : "Gateway key"
  return <DashboardPage spacing="normal">
    <div><Button variant="ghost" nativeButton={false} role="link" render={<Link to={pagePaths.overviewUsage} />}><ArrowLeftIcon data-icon="inline-start" />Back to usage</Button></div>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3"><div className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-muted/30"><KeyRoundIcon className="size-5" /></div><div className="min-w-0"><h2 className="break-words text-2xl font-semibold tracking-tight">{label}</h2><p className="mt-1 break-all text-xs text-muted-foreground">Key usage · {keyId}</p></div></div>
      <Badge variant="outline">Design preview · Sample data</Badge>
    </div>
    <p className="text-sm text-muted-foreground">Three layouts for the same key. All metrics below are illustrative, not this key&apos;s live usage.</p>
    <Tabs defaultValue="snapshot" spacing="comfortable">
      <TabsList aria-label="Key usage design variants" className="max-w-full">
        <TabsTrigger value="snapshot">1 · Snapshot</TabsTrigger><TabsTrigger value="explorer">2 · Explorer</TabsTrigger><TabsTrigger value="budget">3 · Budget</TabsTrigger>
      </TabsList>
      <TabsContent value="snapshot"><SnapshotVariant /></TabsContent>
      <TabsContent value="explorer"><ExplorerVariant /></TabsContent>
      <TabsContent value="budget"><BudgetVariant /></TabsContent>
    </Tabs>
  </DashboardPage>
}

function Metrics() {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[
    { label: "Estimated spend", value: "$87.77", note: "Across 3 models", icon: CoinsIcon },
    { label: "Requests", value: "2.5k", note: "99.4% success rate", icon: ActivityIcon },
    { label: "Tokens processed", value: "210M", note: "68% served from cache", icon: LayersIcon },
    { label: "Budget remaining", value: "$192.23", note: "31% of $280 allocated used", icon: WalletCardsIcon },
  ].map(metric => <Card key={metric.label}><CardHeader><div className="flex items-center justify-between gap-2"><CardDescription>{metric.label}</CardDescription><metric.icon className="size-4 text-muted-foreground" /></div><CardTitle variant="metric">{metric.value}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">{metric.note}</p></CardContent></Card>)}</div>
}

function SpendTrend() {
  return <Card className="h-full"><CardHeader><CardTitle>Daily spend</CardTitle><CardDescription>15–22 Oct 2026 · Sample budget window</CardDescription></CardHeader><CardContent>
    <svg viewBox="0 0 560 210" className="h-56 w-full" role="img" aria-label="Sample daily spend: $8.12, $14.50, $10.35, $18.70, $12.40, $16.50, $7.20">
      {[20, 15, 10, 5, 0].map(value => <g key={value}><line x1="35" x2="550" y1={170 - value * 7.5} y2={170 - value * 7.5} stroke="var(--border)" strokeDasharray="3 4" /><text x="0" y={174 - value * 7.5} fill="var(--muted-foreground)" fontSize="11">${value}</text></g>)}
      {costs.map((cost, index) => <g key={days[index]}><rect x={48 + index * 72} y={170 - cost * 7.5} width="32" height={cost * 7.5} rx="5" fill="var(--primary)" opacity={index === 3 ? 1 : 0.45} /><text x={64 + index * 72} y="198" textAnchor="middle" fill="var(--muted-foreground)" fontSize="11">{days[index]}</text></g>)}
    </svg>
  </CardContent></Card>
}

function ModelMix({ table = false }: { table?: boolean }) {
  return <Card className="h-full"><CardHeader><CardTitle>{table ? "Model breakdown" : "Where the spend goes"}</CardTitle><CardDescription>Resolved models used by this key</CardDescription></CardHeader><CardContent>
    {table ? <Table><TableHeader><TableRow><TableHead>Model</TableHead><TableHead>Requests</TableHead><TableHead>Tokens</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader><TableBody>{models.map(model => <TableRow key={model.name}><TableCell>{model.name}</TableCell><TableCell>{model.requests}</TableCell><TableCell>{model.tokens}</TableCell><TableCell className="text-right">{model.cost}</TableCell></TableRow>)}</TableBody></Table> : <div className="flex flex-col gap-6">{models.map(model => <div key={model.name} className="flex flex-col gap-2"><div className="flex items-center justify-between gap-3"><span className="font-medium">{model.name}</span><span className="tabular-nums">{model.cost}</span></div><Progress value={model.share} aria-label={`${model.name}: ${model.share}% of sample spend`} /><p className="text-xs text-muted-foreground">{model.requests} requests · {model.tokens} tokens · {model.share}% of spend</p></div>)}</div>}
  </CardContent></Card>
}

function RecentAttempts() {
  return <Card><CardHeader><CardTitle>Recent requests</CardTitle><CardDescription>Sample activity for this key only</CardDescription></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Model</TableHead><TableHead>Status</TableHead><TableHead>Tokens</TableHead><TableHead>Cost</TableHead><TableHead>Time</TableHead></TableRow></TableHeader><TableBody>{attempts.map(attempt => <TableRow key={attempt.id}><TableCell>{attempt.model}</TableCell><TableCell><Badge variant="secondary">Success · 200</Badge></TableCell><TableCell>{attempt.tokens}</TableCell><TableCell>{attempt.cost}</TableCell><TableCell tone="muted" className="whitespace-nowrap">21 Oct, {attempt.time}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
}

function BudgetBalance() {
  return <Card className="h-full"><CardHeader><CardTitle>Budget balance</CardTitle><CardDescription>15–22 Oct 2026 · Sample window</CardDescription></CardHeader><CardContent><div className="flex flex-col gap-5"><div><p className="text-sm text-muted-foreground">Remaining this window</p><p className="mt-2 text-4xl font-semibold tracking-tight tabular-nums">$192.23</p></div><Progress value={31.35} aria-label="Sample budget: 31.35 percent used" /><div className="flex justify-between gap-3 text-xs text-muted-foreground"><span>$87.77 used</span><span>$280.00 allocated</span></div><div className="grid grid-cols-2 gap-4 border-t pt-4"><div><p className="text-xs text-muted-foreground">Average daily spend</p><p className="mt-1 font-medium">$12.54</p></div><div><p className="text-xs text-muted-foreground">Budget reset</p><p className="mt-1 font-medium">22 Oct, 13:13</p></div></div></div></CardContent></Card>
}

function SnapshotVariant() {
  return <div className="flex flex-col gap-6"><div><h3 className="text-lg font-medium">At a glance</h3><p className="mt-1 text-sm text-muted-foreground">A balanced overview of activity, spend, and budget.</p></div><Metrics /><div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"><SpendTrend /><ModelMix /></div><RecentAttempts /></div>
}

function ExplorerVariant() {
  return <div className="flex flex-col gap-6"><div><h3 className="text-lg font-medium">Usage explorer</h3><p className="mt-1 text-sm text-muted-foreground">Activity first, with detailed model and request breakdowns.</p></div><div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_280px]"><div className="flex min-w-0 flex-col gap-4"><SpendTrend /><ModelMix table /><RecentAttempts /></div><div className="flex min-w-0 flex-col gap-4"><Card><CardHeader><CardTitle>Window summary</CardTitle><CardDescription>15–22 Oct 2026</CardDescription></CardHeader><CardContent><dl className="flex flex-col gap-4">{[["Spend", "$87.77"], ["Requests", "2,500"], ["Tokens", "210M"], ["Success rate", "99.4%"], ["Avg latency", "1.4 s"]].map(([label, value]) => <div key={label} className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}</dl></CardContent></Card><BudgetBalance /></div></div></div>
}

function BudgetVariant() {
  return <div className="flex flex-col gap-6"><div><h3 className="text-lg font-medium">Budget & spend</h3><p className="mt-1 text-sm text-muted-foreground">A financial view: remaining credit, daily spend, and cost drivers.</p></div><div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]"><BudgetBalance /><SpendTrend /></div><div className="grid items-start gap-4 lg:grid-cols-2"><ModelMix /><Card><CardHeader><CardTitle>Usage profile</CardTitle><CardDescription>How this key consumes its allocation</CardDescription></CardHeader><CardContent><div className="flex flex-col gap-5"><div><p className="text-3xl font-semibold tabular-nums">$0.035</p><p className="mt-1 text-xs text-muted-foreground">Average cost per request</p></div><div className="grid grid-cols-2 gap-4 border-t pt-4"><div><p className="text-lg font-medium">2.5k</p><p className="text-xs text-muted-foreground">Recorded requests</p></div><div><p className="text-lg font-medium">210M</p><p className="text-xs text-muted-foreground">Tokens processed</p></div></div><p className="text-sm text-muted-foreground">GPT-6.1 Sol accounts for 69.3% of this key&apos;s sample spend.</p></div></CardContent></Card></div><RecentAttempts /></div>
}
