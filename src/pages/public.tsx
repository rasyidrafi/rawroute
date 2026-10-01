import { Link, useSearchParams } from "react-router"
import useSWR from "swr"

import { UsageView } from "@/components/dashboard/usage-view"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { PublicWorkspaceSelector } from "@/components/public-workspace-selector"
import { useSession } from "@/hooks/use-session"

type PublicWorkspace = { id: string; name: string; isDefault: boolean }

export function PublicPage() {
  const [searchParams] = useSearchParams()
  const { data: session } = useSession()
  const { data, error } = useSWR<{ workspaces: PublicWorkspace[] }>("/api/public/workspaces", async (url: string) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error("Public workspaces are unavailable.")
    return response.json()
  })
  if (error) return <main className="p-6" role="alert">Public gateway analytics are unavailable. Please try again.</main>
  if (!data) return <DashboardContentSkeleton variant="usage" />
  const workspace = data.workspaces.find((entry) => entry.id === searchParams.get("workspace"))
    || data.workspaces.find((entry) => entry.isDefault)
  if (!workspace) return <main className="p-6">No public workspaces are available.</main>

  return <>
    <header className="border-b bg-background/90 px-4 py-3">
      <div className="mx-auto flex max-w-7xl items-center justify-between">
        <div><div className="font-semibold">RawRoute</div><div className="text-xs text-muted-foreground">Public gateway analytics</div></div>
        <div className="flex items-center gap-3"><PublicWorkspaceSelector workspaces={data.workspaces} workspaceId={workspace.id} /><Link className="text-sm font-medium underline-offset-4 hover:underline" to={session?.authenticated ? "/dashboard" : "/login"}>{session?.authenticated ? "Open dashboard" : "Admin login"}</Link></div>
      </div>
    </header>
    <UsageView key={workspace.id} publicView workspaceId={workspace.id} />
  </>
}
