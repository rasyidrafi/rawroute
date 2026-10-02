import { SettingsLayout, PasswordSettingsCard } from "./settings/settings-layout"
import { toast } from "sonner"

import { ChangePasswordForm } from "@/components/dashboard/change-password-form"
import { apiPost } from "@/components/dashboard/api"
import { useTheme } from "@/components/theme-provider"
import { AppearanceSettingsCard } from "./settings/appearance-settings-card"

export function SettingsView() {
  const { theme, setTheme } = useTheme()
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
  return <SettingsLayout password={<PasswordSettingsCard><ChangePasswordForm onSave={updatePassword} /></PasswordSettingsCard>} appearance={<AppearanceSettingsCard theme={theme} onThemeChange={setTheme} />} />
}
