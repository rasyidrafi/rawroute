import { toolPages } from "../contracts/pages"
import { toolsViews } from "./views"
import { toolsSkeletons } from "./skeletons"
import { toolsApp } from "./navigation"
import type { BrowserModule } from "@rawroute/platform/web/browser-module"

export const toolsBrowserModule = { owner: "tools", pages: toolPages, views: toolsViews, skeletons: toolsSkeletons, app: toolsApp } as const satisfies BrowserModule
