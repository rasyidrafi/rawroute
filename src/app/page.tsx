import Link from "next/link"

import { UsageView } from "@/components/dashboard/usage-view"
import { getDashboardPayload } from "@/lib/analytics"
import type { DashboardQuery } from "@/lib/types"

const initialQuery: DashboardQuery = { preset: "today", granularity: "auto" }

export const dynamic = "force-dynamic"

export default async function Home() {
  const initial = await getDashboardPayload(initialQuery, true).catch(() => undefined)
  return <>
    <header className="border-b bg-background/90 px-4 py-3">
      <div className="mx-auto flex max-w-7xl items-center justify-between">
        <div>
          <div className="font-semibold">RawRoute</div>
          <div className="text-xs text-muted-foreground">Public gateway analytics</div>
        </div>
        <Link className="text-sm font-medium underline-offset-4 hover:underline" href="/login">Admin login</Link>
      </div>
    </header>
    <UsageView initial={initial} publicView />
  </>
}
