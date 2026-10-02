import { Link } from "react-router"
import { ArrowUpRightIcon, SparklesIcon } from "lucide-react"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { pagePaths } from "@/lib/dashboard/routes"

export function BudgetUsageCard() {
  return <Card>
    <CardHeader><CardTitle>Budget Usage</CardTitle></CardHeader>
    <CardContent spacing="compact-stack">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="text-sm text-muted-foreground">Spent this window</span><span className="font-medium tabular-nums">$214.80 / $500</span></div>
      <Progress value={43} aria-label="Sample budget window: 43 percent used" />
      <p className="text-xs text-muted-foreground">57% remaining this window</p>
    </CardContent>
  </Card>
}

export function QuickAccessCard() {
  return <Card className="flex-1"><CardHeader><CardTitle>Quick access</CardTitle><CardDescription>Configure how your workspace runs.</CardDescription></CardHeader><CardContent spacing="compact-stack">{[{ label: "Endpoint & API key", to: pagePaths.dashboard }, { label: "Model routing", to: pagePaths.aliases }, { label: "Budgets", to: pagePaths.budgets }].map(item => <Link key={item.to} to={item.to} className="flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><div><p className="text-sm font-medium">{item.label}</p></div><ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" /></Link>)}</CardContent></Card>
}

const recentRequests = [
  { id: "sample-1", model: "GPT-5", success: false, duration: "5.7s", time: "Just now" },
  { id: "sample-2", model: "Claude Sonnet", success: true, duration: "1.4s", time: "2 min ago" },
  { id: "sample-3", model: "Gemini Flash", success: true, duration: "0.8s", time: "4 min ago" },
  { id: "sample-4", model: "GPT-5", success: true, duration: "1.2s", time: "6 min ago" },
]

export function RecentRequestsCard() {
  return <Card>
    <CardHeader>
      <CardTitle>Recent Requests</CardTitle>
      <CardDescription>Latest API requests</CardDescription>
      <CardAction><Button variant="link" size="sm" className="h-auto p-0 text-primary" nativeButton={false} render={<Link to={pagePaths.usage} />}>View all</Button></CardAction>
    </CardHeader>
    <CardContent>
      <ul className="space-y-3">
        {recentRequests.map(request => <li key={request.id} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-1 sm:grid-cols-[2rem_minmax(0,1fr)_auto_2.75rem_5rem]">
          <span className="row-span-2 flex size-8 items-center justify-center rounded-lg border border-border/70 sm:row-span-1" aria-hidden="true">
            <span className="flex size-5 items-center justify-center rounded bg-primary text-primary-foreground"><SparklesIcon className="size-3.5" /></span>
          </span>
          <p className="min-w-0 truncate font-semibold">{request.model}</p>
          <span className={`justify-self-end rounded-md px-2 py-0.5 text-xs font-medium ${request.success ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>{request.success ? "Success" : "Failed"}</span>
          <span className="col-start-2 row-start-2 font-semibold tabular-nums text-muted-foreground sm:col-start-auto sm:row-start-auto sm:text-right"><span className="sr-only">Duration: </span>{request.duration}</span>
          <span className="col-start-3 row-start-2 whitespace-nowrap text-right text-xs text-muted-foreground sm:col-start-auto sm:row-start-auto sm:text-sm">{request.time}</span>
        </li>)}
      </ul>
    </CardContent>
  </Card>
}
