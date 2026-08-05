import { redirect } from "next/navigation"

import { UsageView } from "@/components/dashboard/usage-view"
import { isAuthenticated } from "@/lib/auth"


export default async function UsagePage() {
  if (!(await isAuthenticated())) redirect("/login")
  return <UsageView />
}
