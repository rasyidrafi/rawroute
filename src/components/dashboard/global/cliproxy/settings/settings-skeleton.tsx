import { Button } from "@/components/ui/button"
import { CliProxySettingsCard, CliProxySettingsLayout } from "./settings-layout"
import { SettingsFields } from "./settings-fields"
export function CliProxySettingsSkeleton() {
  return <div aria-label="Loading CLIProxyAPI settings"><SettingsFields footer={<Button disabled>Save settings</Button>} /></div>
}
export function CliProxySettingsPageSkeleton() {
  return <CliProxySettingsLayout loading><CliProxySettingsCard><CliProxySettingsSkeleton /></CliProxySettingsCard></CliProxySettingsLayout>
}
