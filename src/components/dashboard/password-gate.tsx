import { Button } from "@/components/ui/button"
import { useWorkspace } from "./workspace-provider"
import type { ReactNode } from "react"
import useSWR from "swr"
import { toast } from "sonner"

import { PasswordDialog } from "@/components/dashboard/password-dialog"
import { apiPost } from "@/components/dashboard/api"
import { DashboardRouteSkeleton } from "@/components/dashboard-skeleton"

type AccountResponse = { mustChangePassword: boolean }

export function DashboardPasswordGate({ children }: { children: ReactNode }) {
  const { refreshWorkspaces } = useWorkspace()
  const { data, error, mutate } = useSWR<AccountResponse>("/api/admin/account")

  async function savePassword(password: string) {
    try {
      await apiPost("/api/admin/account/password", { password })
      await mutate()
      void refreshWorkspaces().catch(() => undefined)
      toast.success("Password changed")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to change password")
      return false
    }
  }

  if (!data && !error) {
    return <DashboardRouteSkeleton />
  }

  if (error) return <main className="p-6" role="alert"><p>Unable to check administrator password status.</p><Button onClick={() => void mutate()}>Retry</Button></main>
  if (data?.mustChangePassword) return <><DashboardRouteSkeleton /><PasswordDialog open onSave={savePassword} /></>
  return children
}
