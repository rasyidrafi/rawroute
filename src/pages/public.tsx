import { useSearchParams } from "react-router"
import useSWR from "swr"

import { UsageView } from "@/components/dashboard/usage-view"
import { DashboardContentSkeleton } from "@/components/dashboard-skeleton"
import { PublicWorkspaceSelector } from "@/components/public-workspace-selector"
import { useSession } from "@/hooks/use-session"
import { PublicPageLayout } from "@/components/public-page-layout"

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
  if (!data) return <PublicPageLayout loading authenticated={session?.authenticated}><DashboardContentSkeleton variant="usage" /></PublicPageLayout>
  const workspace = data.workspaces.find((entry) => entry.id === searchParams.get("workspace"))
    || data.workspaces.find((entry) => entry.isDefault)
  if (!workspace) return <main className="p-6">No public workspaces are available.</main>

  return <PublicPageLayout authenticated={session?.authenticated} selector={<PublicWorkspaceSelector workspaces={data.workspaces} workspaceId={workspace.id} />}>
    <UsageView key={workspace.id} publicView workspaceId={workspace.id} />
  </PublicPageLayout>
}
