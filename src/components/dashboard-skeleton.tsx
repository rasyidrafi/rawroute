import { Skeleton } from "@/components/ui/skeleton"

export function DashboardSkeleton() {
  return <DashboardContentSkeleton />
}

export function DashboardContentSkeleton() {
  return <main aria-busy="true" aria-label="Loading dashboard" className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8" data-slot="dashboard-content-skeleton">
    <div className="mx-auto flex max-w-7xl flex-col gap-8">
      <section className="rounded-xl border bg-card p-6">
        <div className="flex items-start justify-between gap-4"><div className="min-w-0 flex-1"><Skeleton className="h-6 w-32" /><Skeleton className="mt-2 h-4 w-80 max-w-full" /></div><Skeleton className="h-9 w-32 shrink-0" /></div>
        <div className="mt-8 space-y-3">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div>
      </section>
      <section className="rounded-xl border bg-card p-6"><Skeleton className="h-6 w-40" /><Skeleton className="mt-2 h-4 w-96 max-w-full" /><div className="mt-6 grid gap-3 md:grid-cols-3">{Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-lg" />)}</div></section>
    </div>
  </main>
}
