import { Skeleton } from "@/components/ui/skeleton"
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuItem, SidebarMenuSkeleton, SidebarProvider } from "@/components/ui/sidebar"
import { DashboardRouteSkeleton } from "@/components/dashboard-skeleton"

export function DashboardFrameSkeleton() {
  return <SidebarProvider style={{ "--sidebar-width": "17rem", "--header-height": "3rem" } as React.CSSProperties}>
    <Sidebar variant="inset"><SidebarHeader><Skeleton className="h-16 w-full" /></SidebarHeader><SidebarContent>{[0, 1, 2].map(group => <SidebarGroup key={group}><Skeleton className="mb-2 h-4 w-20" /><SidebarGroupContent><SidebarMenu>{[0, 1, 2].map(item => <SidebarMenuItem key={item}><SidebarMenuSkeleton showIcon /></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup>)}</SidebarContent><SidebarFooter><Skeleton className="h-8 w-full" /></SidebarFooter></Sidebar>
    <SidebarInset><header className="sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center border-b bg-background/90"><div className="flex w-full min-w-0 items-center gap-3 px-4 lg:px-6"><Skeleton className="size-7 shrink-0" /><Skeleton className="h-5 w-36" /><Skeleton className="ml-auto h-5 w-20 shrink-0 sm:w-24" /></div></header><DashboardRouteSkeleton /></SidebarInset>
  </SidebarProvider>
}
