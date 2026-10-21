import { pagePathsFor, type DashboardPageMeta } from "@rawroute/platform/contracts/dashboard"
export const storagePages = {
  storageOverview: { path: "/dashboard/storage/overview", title: "Overview", scope: "workspace", owner: "storage", app: "storage-gateway", skeleton: "storage" },
  storageConnections: { path: "/dashboard/storage/connections", title: "Connections", scope: "workspace", owner: "storage", app: "storage-gateway", skeleton: "storage" },
  storageBuckets: { path: "/dashboard/storage/buckets", title: "Buckets", scope: "workspace", owner: "storage", app: "storage-gateway", skeleton: "storage" },
  storageKeys: { path: "/dashboard/storage/keys", title: "Client keys", scope: "workspace", owner: "storage", app: "storage-gateway", skeleton: "storage" },
} as const satisfies Record<string, DashboardPageMeta>
export const storagePagePaths = pagePathsFor(storagePages)
