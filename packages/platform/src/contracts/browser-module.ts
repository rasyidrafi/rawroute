import type { DashboardOwner, DashboardPageMeta } from "./dashboard"

/** Metadata-only side of a statically registered browser module. Views stay in web. */
export type BrowserModuleMetadata = {
  owner: DashboardOwner
  pages: Readonly<Record<string, DashboardPageMeta>>
}
