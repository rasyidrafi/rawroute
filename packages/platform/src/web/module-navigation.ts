import { SettingsIcon } from "lucide-react"
import { platformPages } from "../contracts/dashboard"
import { navigationFor } from "@rawroute/ui/navigation"

export const platformGlobalNavigation = [navigationFor(platformPages)("settings", SettingsIcon)]
