import { aiPages } from "../contracts/pages"
import { aiViews } from "./views"
import { aiSkeletons } from "./skeletons"
import { aiApp, aiGlobalNavigation } from "./navigation"
import type { BrowserModule } from "@rawroute/platform/web/browser-module"
import { aiPublicRoutes } from "./public-routes"

export const aiBrowserModule = { owner: "ai", pages: aiPages, views: aiViews, skeletons: aiSkeletons, app: aiApp, sharedNavigation: { global: aiGlobalNavigation }, publicRoutes: aiPublicRoutes } as const satisfies BrowserModule
