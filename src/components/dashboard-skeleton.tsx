import { Skeleton } from "@/components/ui/skeleton"

type DashboardSkeletonVariant = "default" | "endpoint-key" | "providers" | "oauth-providers" | "aliases" | "provider-detail" | "settings" | "usage" | "budgets" | "model-pricing" | "console-log"
type DashboardSkeletonProps = { variant?: DashboardSkeletonVariant }

function SkeletonTable({ columns, rows = 3 }: { columns: number; rows?: number }) {
  return <div className="mt-8 overflow-hidden"><div className="grid gap-4 border-b px-2 pb-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{Array.from({ length: columns }).map((_, index) => <Skeleton key={index} className="h-4 w-20 max-w-full" />)}</div><div>{Array.from({ length: rows }).map((_, row) => <div key={row} className="grid min-h-14 items-center gap-4 border-b px-2 last:border-0" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{Array.from({ length: columns }).map((_, column) => <Skeleton key={column} className={`h-4 ${column === 0 ? "w-40 max-w-full" : "w-24 max-w-full"}`} />)}</div>)}</div></div>
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  return <main aria-busy="true" aria-label="Loading dashboard" className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8" data-slot="dashboard-content-skeleton"><div className="mx-auto flex max-w-7xl flex-col gap-8">{children}</div></main>
}

function CardHeading({ titleWidth = "w-40", descriptionWidth = "w-96", actionWidth }: { titleWidth?: string; descriptionWidth?: string; actionWidth?: string }) {
  return <div className="flex items-start justify-between gap-4"><div className="min-w-0 flex-1"><Skeleton className={`h-6 ${titleWidth}`} /><Skeleton className={`mt-2 h-4 max-w-full ${descriptionWidth}`} /></div>{actionWidth && <Skeleton className={`h-9 shrink-0 ${actionWidth}`} />}</div>
}

function ProvidersSkeleton() {
  return <><section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-32" descriptionWidth="w-[28rem]" actionWidth="w-32" /><SkeletonTable columns={7} rows={3} /></section><section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-44" descriptionWidth="w-80" /><SkeletonTable columns={6} rows={1} /><Skeleton className="mt-4 h-4 w-72 max-w-full" /></section></>
}

function OAuthProvidersSkeleton() {
  return <section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-48" descriptionWidth="w-[34rem]" actionWidth="w-36" /><div className="mt-6 rounded-lg border bg-muted/20 p-4"><Skeleton className="h-4 w-40" /><Skeleton className="mt-2 h-4 w-full max-w-2xl" /></div><SkeletonTable columns={7} rows={3} /></section>
}

function EndpointKeySkeleton() {
  return <>
    <section className="rounded-xl border bg-card p-6"><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><Skeleton className="size-5 rounded" /><Skeleton className="h-6 w-36" /></div><Skeleton className="mt-2 h-4 w-[30rem] max-w-full" /></div></div><div className="mt-6 flex h-10 items-center gap-3 rounded-lg border p-3"><Skeleton className="h-6 w-16 shrink-0 rounded-md" /><Skeleton className="h-4 flex-1" /><Skeleton className="size-7 shrink-0" /></div></section>
    <section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-44" descriptionWidth="w-80" actionWidth="w-28" /><div className="mt-6 space-y-3">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="flex h-12 items-center gap-3 rounded-lg border p-3"><div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-4 w-40 max-w-full" /><Skeleton className="h-3 w-56 max-w-full" /></div><Skeleton className="size-7" /><Skeleton className="size-7" /></div>)}</div></section>
  </>
}

function AliasesSkeleton() {
  return <section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-44" descriptionWidth="w-[28rem]" actionWidth="w-28" /><SkeletonTable columns={4} rows={4} /></section>
}

function ProviderDetailSkeleton() {
  return <>
    <div><Skeleton className="mb-3 h-8 w-28" /><Skeleton className="h-8 w-56" /><Skeleton className="mt-2 h-4 w-40" /></div>
    <section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-44" descriptionWidth="w-72" actionWidth="w-44" /><div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">{Array.from({ length: 5 }).map((_, index) => <div key={index} className="rounded-lg border p-4"><Skeleton className="h-3 w-24" /><Skeleton className="mt-3 h-4 w-28 max-w-full" /></div>)}</div></section>
    <section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-28" descriptionWidth="w-[32rem]" actionWidth="w-32" /><SkeletonTable columns={6} rows={3} /></section>
    <section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-24" descriptionWidth="w-72" actionWidth="w-28" /><SkeletonTable columns={5} rows={3} /></section>
  </>
}

function SettingsSkeleton() {
  return <section className="max-w-2xl rounded-xl border bg-card p-6"><CardHeading titleWidth="w-40" descriptionWidth="w-80" /><div className="mt-6 grid gap-5">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-8 w-full" /></div>)}<Skeleton className="h-9 w-32" /></div></section>
}

function UsageSkeleton() {
  return <>
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><Skeleton className="h-8 w-52" /><Skeleton className="mt-2 h-4 w-80 max-w-full" /></div><div className="flex gap-2"><Skeleton className="h-9 w-36" /><Skeleton className="h-9 w-24" /><Skeleton className="h-9 w-24" /></div></div>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <section key={index} className="rounded-xl border bg-card p-6"><Skeleton className="h-4 w-24" /><Skeleton className="mt-3 h-9 w-32" /><Skeleton className="mt-5 h-4 w-full" /></section>)}</div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)]">{Array.from({ length: 2 }).map((_, index) => <section key={index} className="rounded-xl border bg-card p-6"><CardHeading titleWidth={index ? "w-24" : "w-48"} descriptionWidth="w-48" /><Skeleton className="mt-6 h-[280px] w-full" /></section>)}</div>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]"><section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-32" descriptionWidth="w-40" /><SkeletonTable columns={6} rows={4} /></section><section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-28" descriptionWidth="w-48" /><div className="mt-6 space-y-3">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="flex items-center justify-between rounded-lg border p-3"><div className="space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-24" /></div><div className="space-y-2"><Skeleton className="ml-auto h-4 w-16" /><Skeleton className="ml-auto h-3 w-20" /></div></div>)}</div></section></div>
    <div className="flex gap-2"><Skeleton className="h-5 w-28" /><Skeleton className="h-5 w-24" /><Skeleton className="h-4 w-40" /></div>
  </>
}

function BudgetsSkeleton() {
  return <section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-28" descriptionWidth="w-[34rem]" actionWidth="w-24" /><div className="mt-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"><Skeleton className="h-10 w-64" /><div className="flex gap-3"><Skeleton className="h-10 w-40" /><Skeleton className="h-10 w-32" /></div></div><div className="mt-4 flex items-center justify-between rounded-lg border p-4"><div className="space-y-2"><Skeleton className="h-4 w-28" /><Skeleton className="h-4 w-64 max-w-full" /></div><Skeleton className="h-9 w-24" /></div><SkeletonTable columns={6} rows={3} /></section>
}

function ModelPricingSkeleton() {
  return <section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-36" descriptionWidth="w-[34rem]" actionWidth="w-24" /><div className="mt-6 grid gap-3 rounded-lg border bg-muted/20 p-4 md:grid-cols-2 xl:grid-cols-6">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className={`h-10 ${index === 0 ? "xl:col-span-2" : ""}`} />)}</div><SkeletonTable columns={6} rows={3} /></section>
}

function ConsoleLogSkeleton() {
  return <main aria-busy="true" aria-label="Loading console log" className="h-[calc(100svh-var(--header-height))] max-h-[calc(100svh-var(--header-height))] min-h-0 flex-none overflow-hidden bg-[#f6f5f1] p-4 dark:bg-background md:h-[calc(100svh-var(--header-height)-1rem)] md:max-h-[calc(100svh-var(--header-height)-1rem)] md:p-6 lg:p-8"><div className="mx-auto h-full max-w-7xl"><section className="h-full rounded-xl border bg-card p-6"><div className="flex items-start justify-between gap-4"><div><Skeleton className="h-6 w-32" /><Skeleton className="mt-2 h-4 w-80 max-w-full" /></div><div className="flex gap-2"><Skeleton className="h-9 w-24" /><Skeleton className="h-9 w-24" /><Skeleton className="h-9 w-24" /></div></div><div className="mt-6 flex flex-col gap-3 border-y py-4 lg:flex-row lg:items-center"><div className="flex gap-2">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-8 w-14" />)}</div><div className="flex flex-1 justify-end gap-3"><Skeleton className="h-9 w-64 max-w-full" /><Skeleton className="h-5 w-16" /></div></div><div className="mt-4 h-[calc(100%-10rem)] rounded-lg bg-slate-950 p-4">{Array.from({ length: 10 }).map((_, index) => <Skeleton key={index} className="mb-3 h-4 w-full bg-slate-800" />)}</div></section></div></main>
}

export function DashboardSkeleton({ variant }: DashboardSkeletonProps = {}) {
  return <DashboardContentSkeleton variant={variant} />
}

export function DashboardContentSkeleton({ variant = "default" }: DashboardSkeletonProps = {}) {
  if (variant === "usage") return <DashboardShell><UsageSkeleton /></DashboardShell>
  if (variant === "budgets") return <DashboardShell><BudgetsSkeleton /></DashboardShell>
  if (variant === "model-pricing") return <DashboardShell><ModelPricingSkeleton /></DashboardShell>
  if (variant === "console-log") return <ConsoleLogSkeleton />
  if (variant === "providers") return <DashboardShell><ProvidersSkeleton /></DashboardShell>
  if (variant === "oauth-providers") return <DashboardShell><OAuthProvidersSkeleton /></DashboardShell>
  if (variant === "aliases") return <DashboardShell><AliasesSkeleton /></DashboardShell>
  if (variant === "endpoint-key") return <DashboardShell><EndpointKeySkeleton /></DashboardShell>
  if (variant === "provider-detail") return <DashboardShell><ProviderDetailSkeleton /></DashboardShell>
  if (variant === "settings") return <DashboardShell><SettingsSkeleton /></DashboardShell>
  return <DashboardShell><EndpointKeySkeleton /></DashboardShell>
}
