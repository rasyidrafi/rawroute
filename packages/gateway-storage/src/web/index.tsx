import { lazy } from "react"
import { DatabaseIcon, HardDriveIcon, KeyRoundIcon, PlugIcon } from "lucide-react"
import { navigationFor } from "@rawroute/ui/navigation"
import type { BrowserModule } from "@rawroute/platform/web/browser-module"
import { storagePages, storagePagePaths } from "../contracts/pages"
import { storageSkeletons } from "./skeletons"
const StorageView = lazy(() => import("./storage-view").then(module => ({ default: module.StorageView })))
const nav = navigationFor(storagePages)
export const storageBrowserModule = {
  owner: "storage", pages: storagePages,
  views: { storageOverview: <StorageView page="overview" />, storageConnections: <StorageView page="connections" />, storageBuckets: <StorageView page="buckets" />, storageKeys: <StorageView page="keys" /> },
  skeletons: storageSkeletons,
  app: { id: "storage-gateway", title: "Storage Gateway", description: "Workspace-scoped S3 buckets and client keys", icon: HardDriveIcon, href: storagePagePaths.storageOverview, showAppTitle: true, navigation: [{ label: "Gateway", items: [nav("storageOverview", HardDriveIcon), nav("storageConnections", PlugIcon), nav("storageBuckets", DatabaseIcon), nav("storageKeys", KeyRoundIcon)] }] },
} satisfies BrowserModule

export { useStorageAvailability } from "./availability"
