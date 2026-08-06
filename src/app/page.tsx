import Link from "next/link"

import { UsageView } from "@/components/dashboard/usage-view"
import { PublicWorkspaceSelector } from "@/components/public-workspace-selector"
import { getDashboardPayload } from "@/lib/analytics"
import { DEFAULT_DASHBOARD_QUERY } from "@/lib/dashboard-query"
import { DEFAULT_WORKSPACE_ID, runInWorkspace } from "@/lib/workspace-context"
import { listWorkspaces } from "@/lib/workspaces"

const initialQuery = DEFAULT_DASHBOARD_QUERY

export const dynamic = "force-dynamic"

export default async function Home({ searchParams }: { searchParams: Promise<{ workspace?: string | string[] }> }) {
  const workspaces = (await listWorkspaces()).filter((workspace) => workspace.status === "active")
  const requested = (await searchParams).workspace
  const requestedId = Array.isArray(requested) ? requested[0] : requested
  const workspace = workspaces.find((entry) => entry.id === requestedId) || workspaces.find((entry) => entry.id === DEFAULT_WORKSPACE_ID)!
  const initial = await runInWorkspace(workspace, () => getDashboardPayload(initialQuery, true)).catch(() => undefined)
  return <>
    <header className="border-b bg-background/90 px-4 py-3">
      <div className="mx-auto flex max-w-7xl items-center justify-between">
        <div>
          <div className="font-semibold">RawRoute</div>
          <div className="text-xs text-muted-foreground">Public gateway analytics</div>
        </div>
        <div className="flex items-center gap-3"><PublicWorkspaceSelector workspaces={workspaces.map(({ id, name }) => ({ id, name }))} workspaceId={workspace.id} /><Link className="text-sm font-medium underline-offset-4 hover:underline" href="/login">Admin login</Link></div>
      </div>
    </header>
    <UsageView key={workspace.id} initial={initial} publicView workspaceId={workspace.id} />
  </>
}
