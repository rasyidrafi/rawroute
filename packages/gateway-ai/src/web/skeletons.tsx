import { OverviewSkeleton } from "./components/overview-view"
import { RequestLogsView } from "./components/request-logs-view"
import { PlusIcon, Clock3Icon, BoxesIcon, DollarSignIcon, KeyRoundIcon, LinkIcon, ListOrderedIcon, RouteIcon, Share2Icon, WalletCardsIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@rawroute/ui/button"
import { IntegrationsView } from "./components/integrations-view"
import { IntegrationDetailView } from "./components/integrations/detail-view"
import { Skeleton } from "@rawroute/ui/skeleton"
import { LoadingCard, LoadingTable } from "@rawroute/ui/loading-layout"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { UsageSkeleton } from "./components/usage-skeleton"
import { KeyUsageSkeleton } from "./components/key-usage-skeleton"
import { aiPages } from "../contracts/pages"

type DashboardSkeletonVariant = typeof aiPages[keyof typeof aiPages]["skeleton"]
export const aiSkeletons = Object.fromEntries(Object.entries(aiPages).map(([id, page]) => [id, <AiContentSkeleton key={id} variant={page.skeleton} />]))

export function AiContentSkeleton({ variant }: { variant: DashboardSkeletonVariant }) {
  if (variant === "overview") return <OverviewSkeleton />
  if (variant === "integrations") return <IntegrationsView />
  if (variant === "integration-opencode") return <IntegrationDetailView integration="opencode" />
  if (variant === "integration-codex") return <IntegrationDetailView integration="codex" />
  return <StandardDashboardSkeleton variant={variant} />
}

function StandardDashboardSkeleton({ variant }: { variant: Exclude<DashboardSkeletonVariant, "overview" | "integrations" | "integration-opencode" | "integration-codex"> }) {
  if (variant === "request-logs") return <RequestLogsView />
  if (variant === "usage") return <UsageSkeleton />
  if (variant === "key-usage") return <KeyUsageSkeleton />
  const content = {
    "endpoint-key": <EndpointKeySkeleton />,
    "providers": <ProvidersSkeleton />,
    "aliases": <AliasesSkeleton />,
    "provider-detail": <ProviderDetailSkeleton codex={false} />,
    "codex-detail": <ProviderDetailSkeleton codex />,
    "budgets": <BudgetsSkeleton />,
    "model-pricing": <LoadingCard title={<><DollarSignIcon />Model pricing</>} description="Group compatible gateway models, version their rates, and optionally apply a replacement rate to all stored usage."><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="font-medium">Model groups</div><div className="text-sm text-muted-foreground">Fixed groups are refreshed from configured models; custom groups collect models you choose.</div></div><Skeleton className="h-8 w-36" /></div><LoadingTable columns={["Group", "Type", "Models", "Current pricing", ""]} /></LoadingCard>,
  }
  const normal = ["budgets", "model-pricing"].includes(variant)
  return <DashboardPage spacing={normal ? "normal" : "wide"} width="default" aria-busy="true" aria-label="Loading dashboard" data-slot="dashboard-content-skeleton" data-variant={variant}>
    {content[variant]}
  </DashboardPage>
}

function EndpointKeySkeleton() {
  return <><LoadingCard title={<><RouteIcon className="size-5" />API Endpoint</>} description="Use this base URL with the native protocol endpoint supported by each model."><div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3"><Skeleton className="h-5 w-16 shrink-0" /><Skeleton className="h-5 min-w-0 flex-1" /><Skeleton className="size-7 shrink-0" /></div></LoadingCard>
    <LoadingCard title="Gateway API keys" description="Clients use these keys to access every proxy endpoint." action={<Button disabled><PlusIcon />Create key</Button>}><div className="flex flex-col gap-3">{Array.from({ length: 3 }, (_, index) => <div key={index} className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3"><div className="flex min-w-0 flex-1 flex-col gap-2"><Skeleton className="h-4 w-40 max-w-full" /><Skeleton className="h-3 w-56 max-w-full" /></div>{[0, 1, 2].map(key => <Skeleton key={key} className="size-7 shrink-0" />)}</div>)}</div></LoadingCard></>
}

function ProvidersSkeleton() {
  return <><LoadingCard title="Providers" description="Choose a provider to manage its connection settings and upstream API keys." action={<Button disabled><PlusIcon />Add provider</Button>}><LoadingTable columns={["Provider", "Prefix", "Protocol", "Origin", "API keys", "Models", ""]} /></LoadingCard><LoadingCard title={<><LinkIcon className="size-5" />Codex Providers</>} description="Manage Codex accounts separately from ordinary provider API keys."><LoadingTable columns={["Provider", "Prefix", "Protocol", "Accounts", "Models", ""]} rows={1} /><p className="text-sm text-muted-foreground">Open the Codex provider page to add an account.</p></LoadingCard></>
}

function AliasesSkeleton() {
  return <><LoadingCard title={<><ListOrderedIcon />Combos</>} description="Select one model to create an alias, or multiple models to try in fallback order." action={<Button disabled><PlusIcon />Add combo</Button>}><LoadingTable columns={["Gateway ID", "Name", "Models / fallback order", "Actions"]} /></LoadingCard><LoadingCard title={<><Share2Icon />Shared Models</>} description="Read-only models shared into this workspace. Add one to a combo to give it a local gateway ID."><LoadingTable columns={["Qualified model", "Source workspace", "Status", "Action"]} /></LoadingCard></>
}

function ProviderDetailSkeleton({ codex }: { codex: boolean }) {
  return <><div><Skeleton className="mb-3 h-8 w-28" /><Skeleton className="h-8 w-56 max-w-full" /><Skeleton className="mt-1 h-5 w-40" /></div><LoadingCard title="Provider details" action={!codex} description={<Skeleton className="h-5 w-64 max-w-full" />}><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(120px,1fr))]">{["Gateway prefix", "Authentication", "Protocol", "Prompt cache key", codex ? "Configured accounts" : "Configured keys", "Configured models"].map(label => <div key={label} className="rounded-lg border bg-muted/20 p-4"><div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div><Skeleton className="mt-2 h-5 w-24 max-w-full" /></div>)}</div></LoadingCard>{codex && <LoadingCard title="Codex reset automation" description="Configure expiry-based automatic reset-credit redemption."><Skeleton className="h-12 w-full" /></LoadingCard>}<LoadingCard title={<><KeyRoundIcon className="size-5" />{codex ? "Accounts" : "API keys"}</>} description="Accounts are tried in priority order. Requests fall back when an account is unavailable." action><LoadingTable columns={codex ? ["", "Name", "Plan", "Status", "Usage Limits", "Unused Resets", "Created", ""] : ["", "Name", "Limits", "Status", "Created", ""]} /></LoadingCard><LoadingCard title={<><BoxesIcon className="size-5" />Models</>} description={codex ? "Models are discovered from connected Codex accounts. Custom mappings are preserved. Waiting for first sync." : "Expose upstream models behind your provider prefix."} action><LoadingTable columns={["Model", "Gateway ID", "Upstream model", "Provider protocol", "Status", ""]} /></LoadingCard></>
}

function BudgetsSkeleton() {
  return <>
    <LoadingCard title={<><Clock3Icon className="size-5" />Budget window</>} description="Choose the shared accounting window used by every gateway key.">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-16 w-full" />
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-0 basis-48 grow flex-col gap-2"><span className="text-sm font-medium">Window anchor</span><Skeleton className="h-8 w-full" /></div>
          <Skeleton className="h-8 min-w-0 basis-64 grow" />
          <Button className="w-full sm:w-auto" disabled>Save window</Button>
        </div>
      </div>
    </LoadingCard>
    <LoadingCard title={<><WalletCardsIcon className="size-5" />Budgets</>} description="Weekly USD limits for gateway API keys. Existing keys remain unlimited until configured." action={<Button variant="outline" disabled><RefreshCwIcon />Refresh</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">{["Total budget allocated", "Total budget used"].map(title => <div key={title} className="rounded-xl border bg-muted/20 p-4"><div className="text-sm font-medium">{title}</div><Skeleton className="mt-2 h-8 w-28" /><Skeleton className="mt-3 h-4 w-full" /></div>)}</div>
      <div className="flex flex-wrap items-end gap-3"><Skeleton className="h-8 min-w-0 basis-64 grow" /><Skeleton className="h-8 min-w-0 basis-40 grow" /><Button className="w-full sm:w-auto" disabled>Create budget</Button></div>
      <Skeleton className="h-8 w-64 max-w-full" />
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border">
          <div className="flex flex-col gap-4 border-b bg-muted/10 p-4 sm:flex-row sm:items-start sm:justify-between"><div><div className="font-medium">Unlimited Mode</div><p className="mt-1 text-sm text-muted-foreground">Activate a temporary budget bypass while keeping expensive models blocked.</p></div><Skeleton className="h-9 w-40 shrink-0" /></div>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><div className="text-sm font-medium">Excluded models</div><p className="text-xs text-muted-foreground">These models cannot start new requests while Unlimited Mode is active.</p></div><Skeleton className="h-5 w-20 shrink-0" /></div>
            <Skeleton className="h-8 w-full" />
            <div className="max-h-80 divide-y overflow-hidden rounded-lg border">{[0, 1, 2].map(key => <div key={key} className="flex items-center gap-3 px-3 py-3"><Skeleton className="size-4 shrink-0" /><div className="flex min-w-0 flex-1 flex-col gap-2"><Skeleton className="h-4 w-40 max-w-full" /><Skeleton className="h-3 w-56 max-w-full" /></div></div>)}</div>
            <div className="flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"><span className="text-muted-foreground">Saved changes apply to new requests immediately. Running requests are not interrupted.</span><Button disabled>Save exclusions</Button></div>
          </div>
        </div>
        <div className="rounded-xl border"><div className="border-b px-4 py-3"><div className="font-medium">Unlimited Mode history</div><div className="text-sm text-muted-foreground">Each activation is recorded as its own session.</div></div><LoadingTable columns={["Started", "Ended", "Duration", "Result"]} rows={1} /></div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-sm font-medium">Budget usage</div><div className="text-xs text-muted-foreground">Usage is measured across the shared budget window.</div></div><div className="flex min-w-0 max-w-full items-center gap-2"><span className="shrink-0 text-xs font-medium text-muted-foreground">Order rows by</span><Skeleton className="h-8 w-44 min-w-0 shrink sm:flex-none" /></div></div>
      <LoadingTable columns={["Key", "Status", "Limit", "Usage", ""]} />
    </LoadingCard>
  </>
}
