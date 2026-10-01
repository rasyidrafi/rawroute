import type { ReactNode } from "react"
import { Link } from "react-router"
import { Skeleton } from "@/components/ui/skeleton"

export function PublicPageLayout({ children, selector, authenticated = false, loading = false }: { children: ReactNode; selector?: ReactNode; authenticated?: boolean; loading?: boolean }) {
  return <>
    <header className="border-b bg-background/90 px-4 py-3" data-slot="public-header">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <div><div className="font-semibold">RawRoute</div><div className="text-xs text-muted-foreground">Public gateway analytics</div></div>
        <div className="flex items-center gap-3">{loading ? <Skeleton className="h-8 w-[190px]" /> : selector}<Link className="text-sm font-medium underline-offset-4 hover:underline" to={authenticated ? "/dashboard" : "/login"}>{authenticated ? "Open dashboard" : "Admin login"}</Link></div>
      </div>
    </header>
    {children}
  </>
}
