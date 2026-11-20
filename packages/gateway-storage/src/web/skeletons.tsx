import type { ReactNode } from "react"
import { PlusIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@rawroute/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { LoadingCard, LoadingTable } from "@rawroute/ui/loading-layout"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { Skeleton } from "@rawroute/ui/skeleton"
import { storagePages } from "../contracts/pages"

import { StorageGuideCards } from "./storage-guide-cards"

function HeaderActions({ label }: { label: string }) {
  return <div className="flex gap-2"><Button variant="outline" size="sm" disabled><RefreshCwIcon />Refresh</Button><Button variant="outline" size="sm" disabled><PlusIcon />{label}</Button></div>
}

type StoragePage = keyof typeof storagePages

const resourceContent = {
  storageConnections: <LoadingCard title="Connections" description="Manage the S3-compatible services that store your workspace objects." action={<HeaderActions label="Add connection" />}><LoadingTable columns={["Connection", "Endpoint", "Capability checks", ""]} actionColumn /></LoadingCard>,
  storageBuckets: <LoadingCard title="Buckets" description="Make existing upstream buckets available under workspace-specific names. A gateway name maps to an existing upstream bucket; RawRoute does not create or delete remote buckets." action={<HeaderActions label="Attach bucket" />}><LoadingTable columns={["Gateway bucket", "Upstream bucket", "Connection", "Status", ""]} actionColumn /></LoadingCard>,
  storageKeys: <LoadingCard title="Client keys" description="Issue and manage credentials with access limited to selected buckets and actions. Each key belongs to this workspace; upstream credentials are never shared with clients." action={<HeaderActions label="Create key" />}><LoadingTable columns={["Client key", "Access key ID", "Buckets", "Actions", "Status", ""]} actionColumn /></LoadingCard>,
} satisfies Partial<Record<StoragePage, ReactNode>>

function OverviewSkeleton() {
  return <DashboardPage spacing="normal" aria-busy="true" aria-label="Loading Storage Gateway" data-slot="dashboard-content-skeleton" data-variant="storage-overview">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 className="text-2xl font-semibold tracking-tight">Storage Gateway</h2><p className="mt-1 text-sm text-muted-foreground">Workspace storage access, client keys, and recovery.</p></div><Button variant="outline" size="sm" disabled><RefreshCwIcon />Refresh</Button></div>
    <div className="grid gap-4 sm:grid-cols-3">{["Connections", "Attached buckets", "Active client keys"].map(label => <Card key={label}><CardHeader><CardDescription>{label}</CardDescription><CardTitle variant="metric"><Skeleton className="h-9 w-16" /></CardTitle></CardHeader></Card>)}</div>
    <StorageGuideCards />
    <LoadingCard title="Multipart recovery" description="Check the bucket before marking an upload as missing."><LoadingTable columns={["Bucket", "Object key", "Connection / key", "Status", ""]} actionColumn rows={2} /></LoadingCard>
  </DashboardPage>
}

export function StorageRouteSkeleton({ page }: { page: StoragePage }) {
  if (page === "storageOverview") return <OverviewSkeleton />
  return <DashboardPage spacing="normal" aria-busy="true" aria-label={`Loading ${storagePages[page].title.toLowerCase()}`} data-slot="dashboard-content-skeleton" data-variant="storage">
    {resourceContent[page]}
  </DashboardPage>
}

export const storageSkeletons = Object.fromEntries(Object.keys(storagePages).map(page => [page, <StorageRouteSkeleton key={page} page={page as StoragePage} />]))
