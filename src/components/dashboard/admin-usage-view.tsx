"use client"

import { useWorkspace } from "@/components/dashboard/workspace-provider"
import { UsageView } from "@/components/dashboard/usage-view"

/**
 * The selected admin workspace is browser state, so usage must not receive a
 * server-rendered payload created before that workspace is known.
 */
export function AdminUsageView() {
  const { workspace } = useWorkspace()
  return <UsageView key={workspace.id} workspaceId={workspace.id} />
}
