import { observabilityPages } from "../../contracts/operational-log-pages"
import { observabilityViews } from "./views"
import { observabilitySkeletons } from "./skeletons"
import { observabilityWorkspaceNavigation, observabilityGlobalNavigation } from "./navigation"

export const observabilityBrowserModule = { owner: "observability", pages: observabilityPages, views: observabilityViews, skeletons: observabilitySkeletons, sharedNavigation: { workspace: observabilityWorkspaceNavigation, global: observabilityGlobalNavigation } } as const
