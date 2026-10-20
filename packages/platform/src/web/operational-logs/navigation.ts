import { LogsIcon } from "lucide-react"
import { navigationFor } from "@rawroute/ui/navigation"
import { observabilityPages } from "../../contracts/operational-log-pages"

const nav = navigationFor(observabilityPages)
export const observabilityWorkspaceNavigation = [nav("logs", LogsIcon)]
export const observabilityGlobalNavigation = [nav("systemLogs", LogsIcon)]
