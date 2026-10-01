import { ChangePasswordForm } from "@/components/dashboard/change-password-form"
import { PasswordSettingsCard, SettingsLayout } from "./settings-layout"
const noop = async () => false
export function SettingsSkeleton() {
  return <SettingsLayout loading password={<PasswordSettingsCard><ChangePasswordForm loading onSave={noop} /></PasswordSettingsCard>} />
}
