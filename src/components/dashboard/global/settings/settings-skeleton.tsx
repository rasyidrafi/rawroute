import { ChangePasswordForm } from "@/components/dashboard/change-password-form"
import { PasswordSettingsCard, SettingsLayout } from "./settings-layout"
import { AppearanceSettingsCard } from "./appearance-settings-card"
const noop = async () => false
export function SettingsSkeleton() {
  return <SettingsLayout loading password={<PasswordSettingsCard><ChangePasswordForm loading onSave={noop} /></PasswordSettingsCard>} appearance={<AppearanceSettingsCard loading />} />
}
