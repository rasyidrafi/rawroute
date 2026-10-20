import type { ReactElement } from "react"
import type { BrowserModuleMetadata } from "../contracts/browser-module"
import type { DashboardApp, DashboardNavigationItem } from "./navigation"

export type BrowserModule = BrowserModuleMetadata & {
  views: Readonly<Record<string, ReactElement>>
  skeletons: Readonly<Record<string, ReactElement>>
  app?: DashboardApp
  sharedNavigation?: { workspace?: readonly DashboardNavigationItem[]; global?: readonly DashboardNavigationItem[] }
  publicRoutes?: readonly { id: string; path: string; title: string; owner: BrowserModuleMetadata["owner"]; app: "public"; scope: "workspace" | "global"; view: ReactElement; skeleton: ReactElement }[]
}
