"use client"

import { AppSidebar } from "@/components/app-sidebar"
import { DashboardPasswordGate } from "@/components/dashboard/password-gate"
import { DashboardSWRProvider } from "@/components/dashboard/swr-provider"
import { useWorkspace, WorkspaceProvider } from "@/components/dashboard/workspace-provider"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return <WorkspaceProvider><WorkspaceShellContent>{children}</WorkspaceShellContent></WorkspaceProvider>
}

function WorkspaceShellContent({ children }: { children: React.ReactNode }) {
  const { workspace } = useWorkspace()
  return <SidebarProvider style={{ "--sidebar-width": "17rem", "--header-height": "3rem" } as React.CSSProperties}>
    <AppSidebar variant="inset" />
    <SidebarInset><SiteHeader /><DashboardSWRProvider key={workspace.id}><DashboardPasswordGate>{children}</DashboardPasswordGate></DashboardSWRProvider></SidebarInset>
  </SidebarProvider>
}
