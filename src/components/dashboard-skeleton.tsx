import { Skeleton } from "@/components/ui/skeleton"

type DashboardSkeletonVariant = "default" | "endpoint-key" | "providers" | "provider-detail" | "settings"
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
  return <section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-32" descriptionWidth="w-[28rem]" actionWidth="w-32" /><SkeletonTable columns={7} rows={3} /></section>
}

function EndpointKeySkeleton() {
  return <>
    <section className="rounded-xl border bg-card p-6"><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><Skeleton className="size-5 rounded" /><Skeleton className="h-6 w-36" /></div><Skeleton className="mt-2 h-4 w-[30rem] max-w-full" /></div></div><div className="mt-6 flex h-10 items-center gap-3 rounded-lg border p-3"><Skeleton className="h-6 w-16 shrink-0 rounded-md" /><Skeleton className="h-4 flex-1" /><Skeleton className="size-7 shrink-0" /></div></section>
    <section className="rounded-xl border bg-card p-6"><CardHeading titleWidth="w-44" descriptionWidth="w-80" actionWidth="w-28" /><div className="mt-6 space-y-3">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="flex h-12 items-center gap-3 rounded-lg border p-3"><div className="min-w-0 flex-1 space-y-2"><Skeleton className="h-4 w-40 max-w-full" /><Skeleton className="h-3 w-56 max-w-full" /></div><Skeleton className="size-7" /><Skeleton className="size-7" /></div>)}</div></section>
  </>
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

export function DashboardSkeleton({ variant }: DashboardSkeletonProps = {}) {
  return <DashboardContentSkeleton variant={variant} />
}

export function DashboardContentSkeleton({ variant = "default" }: DashboardSkeletonProps = {}) {
  if (variant === "providers") return <DashboardShell><ProvidersSkeleton /></DashboardShell>
  if (variant === "endpoint-key") return <DashboardShell><EndpointKeySkeleton /></DashboardShell>
  if (variant === "provider-detail") return <DashboardShell><ProviderDetailSkeleton /></DashboardShell>
  if (variant === "settings") return <DashboardShell><SettingsSkeleton /></DashboardShell>
  return <DashboardShell><ProvidersSkeleton /></DashboardShell>
}
