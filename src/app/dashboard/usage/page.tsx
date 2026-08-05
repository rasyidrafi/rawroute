import { redirect } from "next/navigation"

import { UsageView } from "@/components/dashboard/usage-view"
import { getDashboardPayload } from "@/lib/analytics"
import { isAuthenticated } from "@/lib/auth"
import type { DashboardQuery } from "@/lib/types"

const initialQuery: DashboardQuery = { preset: "budget", granularity: "auto" }

export default async function UsagePage() {
  if (!(await isAuthenticated())) redirect("/login")
  const initial = await getDashboardPayload(initialQuery).catch(() => undefined)
  return <UsageView initial={initial} />
}
