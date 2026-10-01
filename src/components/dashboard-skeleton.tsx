import { Badge } from "@/components/ui/badge"
import { ArrowLeftRightIcon, PlusIcon, Clock3Icon, BoxesIcon, DollarSignIcon, KeyRoundIcon, LinkIcon, ListOrderedIcon, LockKeyholeIcon, RouteIcon, Share2Icon, WalletCardsIcon, RefreshCwIcon, ClipboardIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LogToolbar } from "@/components/dashboard/logs/log-toolbar"
import { LogResults, LogStatus } from "@/components/dashboard/logs/log-results"
import { CodingAgentView } from "@/components/dashboard/coding-agent-view"
import { useLocation } from "react-router"
import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FormSkeleton, LoadingCard, LoadingTable } from "@/components/loading-layout"
import { DashboardPage, logPageClassName } from "@/components/dashboard/page-layout"
import { UsageSkeleton } from "@/components/dashboard/usage-skeleton"
import { InstanceSettingsSkeleton } from "@/components/dashboard/settings/settings-skeleton"
import { CliProxySkeleton } from "@/components/dashboard/cliproxy/skeleton"
import { dashboardPageForPath, pageRedirects, type DashboardPage as Page } from "@/lib/dashboard/routes"

export type DashboardSkeletonVariant = "endpoint-key" | "providers" | "oauth-providers" | "aliases" | "provider-detail" | "codex-detail" | "settings" | "usage" | "budgets" | "model-pricing" | "console-log" | "system-logs" | "cliproxy" | "coding-agent" | "opencode-agent" | "claude-agent" | "tool-gateway"
const variants: Record<Page, DashboardSkeletonVariant> = {
  dashboard: "endpoint-key", providers: "providers", provider: "provider-detail", codex: "codex-detail", aliases: "aliases", usage: "usage", budgets: "budgets", pricing: "model-pricing",
  logs: "console-log", systemLogs: "system-logs", cliproxy: "cliproxy", settings: "settings", codexAgent: "coding-agent", opencodeAgent: "opencode-agent", claudeAgent: "claude-agent",
  tools: "tool-gateway", toolCatalog: "tool-gateway", toolConnections: "tool-gateway", toolActivity: "tool-gateway", toolPolicies: "tool-gateway", toolSettings: "tool-gateway",
}

export function dashboardSkeletonForPath(path: string): DashboardSkeletonVariant {
  const page = dashboardPageForPath(pageRedirects[path] ?? path)
  return page ? variants[page] : "endpoint-key"
}

export function DashboardRouteSkeleton() {
  const { pathname } = useLocation()
  return <DashboardContentSkeleton variant={dashboardSkeletonForPath(pathname)} />
}

export function DashboardContentSkeleton({ variant }: { variant: DashboardSkeletonVariant }) {
  if (variant === "usage") return <UsageSkeleton />
  if (variant === "console-log" || variant === "system-logs") return <ConsoleLogSkeleton global={variant === "system-logs"} />
  if (variant === "cliproxy") return <CliProxySkeleton />
  if (variant === "coding-agent" || variant === "opencode-agent" || variant === "claude-agent") return <CodingAgentView agent={variant === "coding-agent" ? "Codex" : variant === "opencode-agent" ? "Opencode" : "Claude Code"} />
  const content = {
    "endpoint-key": <EndpointKeySkeleton />,
    "providers": <ProvidersSkeleton />,
    "oauth-providers": <LoadingCard title={<><LinkIcon className="size-5" />Codex Providers</>} description="Connect multiple Codex accounts once and route native Responses requests through this gateway. Usage limits update every five minutes." action><LoadingTable columns={["Account", "Plan", "Status", "Usage Limits", "Unused Resets", "Token expiry", "Actions"]} /></LoadingCard>,
    "aliases": <AliasesSkeleton />,
    "provider-detail": <ProviderDetailSkeleton codex={false} />,
    "codex-detail": <ProviderDetailSkeleton codex />,
    "settings": <><LoadingCard title={<><LockKeyholeIcon className="size-5" />Admin password</>} description="This administrator password applies to every workspace. Confirm the current password before choosing a new one." className="max-w-2xl"><FormSkeleton labels={["Current password", "New password", "Confirm new password"]} /></LoadingCard><LoadingCard title="Global gateway settings" description="These settings apply to the shared CLIProxy service across every workspace." className="max-w-2xl"><InstanceSettingsSkeleton /></LoadingCard></>,
    "budgets": <BudgetsSkeleton />,
    "model-pricing": <LoadingCard title={<><DollarSignIcon />Model pricing</>} description="Group compatible gateway models, version their rates, and optionally apply a replacement rate to all stored usage." action={<Button variant="outline" disabled><RefreshCwIcon />Refresh</Button>}><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="font-medium">Model groups</div><div className="text-sm text-muted-foreground">Fixed groups are refreshed from configured models; custom groups collect models you choose.</div></div><Skeleton className="h-8 w-36" /></div><LoadingTable columns={["Group", "Type", "Models", "Current pricing", ""]} /></LoadingCard>,
    "tool-gateway": <Card><CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle>Executor integration</CardTitle><Badge variant="secondary">Checking</Badge><Badge variant="secondary">API-only</Badge><Badge variant="outline">Shared deployment</Badge></div><CardDescription>RawRoute exposes Executor only through its authenticated public API proxy. Executor&apos;s browser UI, OAuth callbacks, and MCP endpoints are not available here.</CardDescription></CardHeader><CardContent spacing="compact-stack"><div role="status" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Checking the optional Executor service.</div></CardContent></Card>,
  }
  const normal = ["budgets", "model-pricing", "tool-gateway"].includes(variant)
  return <DashboardPage spacing={normal ? "normal" : "wide"} width={variant === "tool-gateway" ? "narrow" : "default"} aria-busy="true" aria-label="Loading dashboard" data-slot="dashboard-content-skeleton" data-variant={variant}>
    {content[variant]}
  </DashboardPage>
}

function EndpointKeySkeleton() {
  return <><LoadingCard title={<><RouteIcon className="size-5" />API Endpoint</>} description="Use this base URL with the native protocol endpoint supported by each model."><div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3"><Skeleton className="h-5 w-16 shrink-0" /><Skeleton className="h-5 min-w-0 flex-1" /><Skeleton className="size-7 shrink-0" /></div></LoadingCard>
    <LoadingCard title="Gateway API keys" description="Clients use these keys to access every proxy endpoint." action={<Button disabled><PlusIcon />Create key</Button>}><div className="space-y-3">{Array.from({ length: 3 }, (_, index) => <div key={index} className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3"><div className="min-w-0 flex-1"><Skeleton className="h-5 w-40 max-w-full" /><Skeleton className="h-4 w-56 max-w-full" /></div>{[0, 1, 2].map(key => <Skeleton key={key} className="size-7 shrink-0" />)}</div>)}</div></LoadingCard></>
}

function ProvidersSkeleton() {
  return <><LoadingCard title="Providers" description="Choose a provider to manage its connection settings and upstream API keys." action={<Button disabled><PlusIcon />Add provider</Button>}><LoadingTable columns={["Provider", "Prefix", "Protocol", "Origin", "API keys", "Models", ""]} /></LoadingCard><LoadingCard title={<><LinkIcon className="size-5" />Codex Providers</>} description="Manage Codex accounts separately from ordinary provider API keys."><LoadingTable columns={["Provider", "Prefix", "Protocol", "Accounts", "Models", ""]} rows={1} /><p className="text-sm text-muted-foreground">Open the Codex provider page to add an account.</p></LoadingCard></>
}

function AliasesSkeleton() {
  return <><LoadingCard title={<><ArrowLeftRightIcon className="size-5" />Aliases</>} description="Create local gateway IDs that forward to enabled local or shared models." action={<Button disabled><PlusIcon />Add alias</Button>}><LoadingTable columns={["Gateway ID", "Name", "Target model", "Status", "Actions"]} /></LoadingCard><LoadingCard title={<><ListOrderedIcon className="size-5" />Combos</>} description="Try models in order until one accepts the request." action={<Button disabled><PlusIcon />Add combo</Button>}><LoadingTable columns={["Gateway ID", "Name", "Fallback order", "Actions"]} /></LoadingCard><LoadingCard title={<><Share2Icon className="size-5" />Shared Models</>} description="Read-only models shared into this workspace. Create a local alias before gateway keys can use one."><LoadingTable columns={["Qualified model", "Source workspace", "Status", "Action"]} /></LoadingCard></>
}

function ProviderDetailSkeleton({ codex }: { codex: boolean }) {
  return <><div><Skeleton className="mb-3 h-8 w-28" /><Skeleton className="h-8 w-56 max-w-full" /><Skeleton className="mt-1 h-5 w-40" /></div><LoadingCard title="Provider details" action={!codex} description={<Skeleton className="h-5 w-64 max-w-full" />}><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(120px,1fr))]">{["Gateway prefix", "Authentication", "Protocol", "Prompt cache key", codex ? "Configured accounts" : "Configured keys", "Configured models"].map(label => <div key={label} className="rounded-lg border bg-muted/20 p-4"><div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div><Skeleton className="mt-2 h-5 w-24 max-w-full" /></div>)}</div></LoadingCard><LoadingCard title={<><KeyRoundIcon className="size-5" />{codex ? "Accounts" : "API keys"}</>} description="The account at the top has the highest priority. CLIProxy uses fill-first routing and only falls through when that account is unavailable." action><LoadingTable columns={codex ? ["", "Name", "Plan", "Status", "Usage Limits", "Unused Resets", "Created", ""] : ["", "Name", "Limits", "Status", "Created", ""]} /></LoadingCard><LoadingCard title={<><BoxesIcon className="size-5" />Models</>} description={codex ? "Models are discovered from connected CLIProxy accounts. Custom mappings are preserved. Waiting for first sync." : "Expose upstream models behind your provider prefix."} action><LoadingTable columns={["Model", "Gateway ID", "Upstream model", "Provider protocol", "Status", ""]} /></LoadingCard></>
}

function BudgetsSkeleton() {
  return <><LoadingCard title={<><Clock3Icon className="size-5" />Budget window</>} description="Choose the shared accounting window used by every gateway key."><div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><Skeleton className="h-16 w-full max-w-sm" /><div className="flex flex-col gap-3 sm:flex-row"><Skeleton className="h-8 w-48 max-w-full" /><Skeleton className="h-8 w-48 max-w-full" /><Skeleton className="h-8 w-28" /></div></div></LoadingCard><LoadingCard title={<><WalletCardsIcon className="size-5" />Budgets</>} description="Weekly USD limits for gateway API keys. Existing keys remain unlimited until configured." action={<Button variant="outline" disabled><RefreshCwIcon />Refresh</Button>}><div className="grid gap-3 sm:grid-cols-2">{["Total budget allocated", "Total budget used"].map(title => <div key={title} className="rounded-xl border bg-muted/20 p-4"><div className="text-sm font-medium">{title}</div><Skeleton className="mt-2 h-8 w-28" /><Skeleton className="mt-3 h-4 w-full" /></div>)}</div><div className="flex flex-col gap-3 sm:flex-row"><Skeleton className="h-8 w-full sm:w-64" /><Skeleton className="h-8 w-full sm:w-40" /><Skeleton className="h-8 w-32" /></div><Skeleton className="h-8 w-64 max-w-full" /><div className="space-y-4"><div className="rounded-xl border"><div className="flex flex-col gap-4 border-b bg-muted/10 p-4 sm:flex-row sm:items-start sm:justify-between"><div><div className="font-medium">Unlimited Mode</div><p className="mt-1 text-sm text-muted-foreground">Activate a temporary budget bypass while keeping expensive models blocked.</p></div><Skeleton className="h-8 w-36" /></div><div className="space-y-3 p-4"><div><div className="text-sm font-medium">Excluded models</div><p className="text-xs text-muted-foreground">These models cannot start new requests while Unlimited Mode is active.</p></div><Skeleton className="h-8 w-full" /><div className="max-h-80 divide-y overflow-hidden rounded-lg border">{[0, 1, 2].map(key => <div key={key} className="flex items-center gap-3 px-3 py-3"><Skeleton className="size-4" /><div className="min-w-0 flex-1"><Skeleton className="h-5 w-40 max-w-full" /><Skeleton className="h-4 w-56 max-w-full" /></div></div>)}</div><div className="flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><span className="text-muted-foreground">Saved changes apply to new requests immediately. Running requests are not interrupted.</span><Button disabled>Save exclusions</Button></div></div></div><div className="rounded-xl border"><div className="border-b px-4 py-3"><div className="font-medium">Unlimited Mode history</div><div className="text-sm text-muted-foreground">Each activation is recorded as its own session.</div></div><LoadingTable columns={["Started", "Ended", "Duration", "Result"]} rows={1} /></div></div><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-sm font-medium">Budget usage</div><div className="text-xs text-muted-foreground">Usage is measured across the shared budget window.</div></div><div className="space-y-2"><span className="text-sm font-medium">Order rows by</span><Skeleton className="h-8 w-44" /></div></div><LoadingTable columns={["Key", "Status", "Limit", "Usage", ""]} /></LoadingCard></>
}

const noop = () => undefined

function ConsoleLogSkeleton({ global }: { global: boolean }) {
  return <main className={logPageClassName} aria-busy="true" aria-label="Loading logs" data-slot="dashboard-content-skeleton"><div className="mx-auto h-full max-w-7xl"><Card className="h-full"><CardHeader className="flex shrink-0 flex-col sm:grid"><CardTitle>{global ? "System Logs" : "Console Log"}</CardTitle><CardDescription>{global ? "Authentication, global administration, and service activity for this instance." : "Gateway and dashboard activity for the selected workspace."} History is kept in memory until the server restarts.</CardDescription><CardAction><div className="flex flex-wrap gap-2"><Button variant="outline" disabled><RefreshCwIcon />Refresh</Button><Button variant="outline" disabled><ClipboardIcon />Copy</Button><Button variant="destructive" disabled><Trash2Icon />Clear</Button></div></CardAction></CardHeader><CardContent spacing="flow" className="flex min-h-0 flex-1 flex-col"><LogToolbar disabled level="all" setLevel={noop} query="" setQuery={noop} source="all" setSource={noop} sources={[]} live setLive={noop} /><LogStatus count={0} snapshot={null} live /><LogResults entries={[]} loading /></CardContent></Card></div></main>
}
