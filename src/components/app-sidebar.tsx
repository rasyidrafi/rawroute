"use client"

import { BoxesIcon, KeyRoundIcon, LogOutIcon, RouteIcon, ServerIcon } from "lucide-react"
import { useRouter } from "next/navigation"

import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"

const navigation = [
  { title: "Overview", icon: RouteIcon, target: "overview" },
  { title: "Providers", icon: ServerIcon, target: "providers" },
  { title: "Models", icon: BoxesIcon, target: "models" },
  { title: "API keys", icon: KeyRoundIcon, target: "keys" },
]

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const router = useRouter()
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" tooltip="RawRoute">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-slate-950 text-white"><RouteIcon className="size-4" /></div>
          <div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-semibold">RawRoute</span><span className="truncate text-xs">Native protocol gateway</span></div>
        </SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup><SidebarGroupLabel>Gateway</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>
          {navigation.map((item) => <SidebarMenuItem key={item.target}><SidebarMenuButton tooltip={item.title} onClick={() => document.getElementById(item.target)?.scrollIntoView({ behavior: "smooth" })}><item.icon /><span>{item.title}</span></SidebarMenuButton></SidebarMenuItem>)}
        </SidebarMenu></SidebarGroupContent></SidebarGroup>
      </SidebarContent>
      <SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton tooltip="Sign out" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); router.push("/login"); router.refresh() }}><LogOutIcon /><span>Sign out</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarFooter>
    </Sidebar>
  )
}
