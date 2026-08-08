import { redirect } from "next/navigation"

import { DashboardShell } from "@/components/dashboard/dashboard-shell"
import { isAuthenticated } from "@/lib/auth"

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAuthenticated())) redirect("/login")
  return <DashboardShell>{children}</DashboardShell>
}
