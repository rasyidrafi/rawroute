import { redirect } from "next/navigation"

import { AdminUsageView } from "@/components/dashboard/admin-usage-view"
import { isAuthenticated } from "@/lib/auth"

export default async function UsagePage() {
  if (!(await isAuthenticated())) redirect("/login")
  return <AdminUsageView />
}
