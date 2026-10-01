// Panel order copied from rawroute-simple/cliproxy-management-panel.tsx.
// Resource components retain RawRoute's workspace protections and OAuth recovery.
import { ManagedKeys, AuthFiles } from "./credentials"
import { GlobalOauth } from "./oauth"
import { EngineLogs } from "./logs"

export function CliproxyManagementPanel() {
  return <div className="flex flex-col gap-6"><ManagedKeys /><GlobalOauth /><AuthFiles /><EngineLogs /></div>
}
