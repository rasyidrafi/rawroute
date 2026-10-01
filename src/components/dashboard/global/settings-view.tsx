import { SettingsLayout, PasswordSettingsCard } from "./settings/settings-layout"
import { InstanceSettingsCard } from "./settings/instance-settings"
import { toast } from "sonner"

import { ChangePasswordForm } from "@/components/dashboard/change-password-form"
import { apiPost } from "@/components/dashboard/api"

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
  return <SettingsLayout gateway={<InstanceSettingsCard />} password={<PasswordSettingsCard><ChangePasswordForm onSave={updatePassword} /></PasswordSettingsCard>} />
}
