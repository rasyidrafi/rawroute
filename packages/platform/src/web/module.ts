import { platformPages } from "../contracts/dashboard"
import { platformViews } from "./views"
import { platformSkeletons } from "./skeletons"
import { platformGlobalNavigation } from "./module-navigation"
import type { BrowserModule } from "./browser-module"

export const platformBrowserModule = { owner: "platform", pages: platformPages, views: platformViews, skeletons: platformSkeletons, sharedNavigation: { global: platformGlobalNavigation } } as const satisfies BrowserModule
