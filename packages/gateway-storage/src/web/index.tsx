import { lazy } from "react"
import { DatabaseIcon, HardDriveIcon, KeyRoundIcon, PlugIcon } from "lucide-react"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@rawroute/ui/card"
import { Skeleton } from "@rawroute/ui/skeleton"
import { navigationFor } from "@rawroute/ui/navigation"
import type { BrowserModule } from "@rawroute/platform/web/browser-module"
import { storagePages, storagePagePaths } from "../contracts/pages"
const StorageView = lazy(() => import("./view").then(module => ({ default: module.StorageView })))
const nav = navigationFor(storagePages)
function StorageSkeleton({ title }: { title: string }) { return <DashboardPage aria-busy="true" aria-label={`Loading ${title.toLowerCase()}`} data-slot="dashboard-content-skeleton" data-variant="storage"><Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>Loading workspace storage.</CardDescription></CardHeader><CardContent><Skeleton className="h-32 w-full" /></CardContent></Card></DashboardPage> }
export const storageBrowserModule = {
  owner: "storage", pages: storagePages,
  views: { storageOverview: <StorageView page="overview" />, storageConnections: <StorageView page="connections" />, storageBuckets: <StorageView page="buckets" />, storageKeys: <StorageView page="keys" /> },
  skeletons: Object.fromEntries(Object.entries(storagePages).map(([id, page]) => [id, <StorageSkeleton key={id} title={page.title} />])),
  app: { id: "storage-gateway", title: "Storage Gateway", description: "Workspace-scoped S3 buckets and client keys", icon: HardDriveIcon, href: storagePagePaths.storageOverview, showAppTitle: true, navigation: [{ label: "Gateway", items: [nav("storageOverview", HardDriveIcon), nav("storageConnections", PlugIcon), nav("storageBuckets", DatabaseIcon), nav("storageKeys", KeyRoundIcon)] }] },
} satisfies BrowserModule
