import { Button } from "@/components/ui/button"
import { ChangePasswordForm } from "@/components/dashboard/change-password-form"
import { GatewaySettingsCard, PasswordSettingsCard, SettingsLayout } from "./settings-layout"
import { SettingsFields } from "./settings-fields"

const noop = async () => false

export function InstanceSettingsSkeleton() {
  return <div aria-label="Loading gateway settings"><SettingsFields footer={<Button disabled>Save settings</Button>} /></div>
}

export function SettingsSkeleton() {
  return <SettingsLayout loading gateway={<GatewaySettingsCard><InstanceSettingsSkeleton /></GatewaySettingsCard>} password={<PasswordSettingsCard><ChangePasswordForm loading onSave={noop} /></PasswordSettingsCard>} />
}
