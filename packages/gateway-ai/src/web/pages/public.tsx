import { useSearchParams } from "react-router"
import useSWR from "swr"

import { UsageView } from "../components/usage-view"
import { AiContentSkeleton as DashboardContentSkeleton } from "../skeletons"
import { PublicWorkspaceSelector } from "@rawroute/platform/web/public-workspace-selector"
import { useSession } from "@rawroute/platform/web/use-session"
import { PublicPageLayout } from "@rawroute/platform/web/public-page-layout"
import { EmptyState } from "@rawroute/ui/empty-state"
import { DatabaseIcon } from "lucide-react"

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
  if (!workspace) return <PublicPageLayout authenticated={session?.authenticated}><main className="mx-auto w-full max-w-7xl p-4 md:p-6"><EmptyState title="No public workspaces are available" description="Public gateway analytics will appear here when a workspace is made public." icon={DatabaseIcon} /></main></PublicPageLayout>

  return <PublicPageLayout authenticated={session?.authenticated} selector={<PublicWorkspaceSelector workspaces={data.workspaces} workspaceId={workspace.id} />}>
    <UsageView key={workspace.id} publicView workspaceId={workspace.id} />
  </PublicPageLayout>
}
