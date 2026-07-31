import { DashboardSWRProvider } from "@/components/dashboard/swr-provider"
import { DashboardPasswordGate } from "@/components/dashboard/password-gate"
import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <SidebarProvider style={{ "--sidebar-width": "17rem", "--header-height": "3rem" } as React.CSSProperties}>
    <AppSidebar variant="inset" />
    <SidebarInset><SiteHeader /><DashboardSWRProvider><DashboardPasswordGate>{children}</DashboardPasswordGate></DashboardSWRProvider></SidebarInset>
  </SidebarProvider>
}
