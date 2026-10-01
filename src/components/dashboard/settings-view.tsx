import { DashboardPage } from "@/components/dashboard/page-layout"
import { InstanceSettingsCard } from "./settings/instance-settings"
import { LockKeyholeIcon } from "lucide-react"
import { toast } from "sonner"

import { ChangePasswordForm } from "@/components/dashboard/change-password-form"
import { apiPost } from "@/components/dashboard/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function SettingsView() {
  async function updatePassword(currentPassword: string, newPassword: string, confirmPassword: string) {
    try {
      await apiPost("/api/admin/account/password", { currentPassword, newPassword, confirmPassword })
      toast.success("Password updated")
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed")
      return false
    }
  }
  return <DashboardPage>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle variant="icon"><LockKeyholeIcon className="size-5" />Admin password</CardTitle>
          <CardDescription>This administrator password applies to every workspace. Confirm the current password before choosing a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm onSave={updatePassword} />
        </CardContent>
      </Card>
      <InstanceSettingsCard />
    </DashboardPage>
}
