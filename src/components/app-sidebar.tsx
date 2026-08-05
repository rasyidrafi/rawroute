"use client"

import { ArrowLeftRightIcon, ChartNoAxesCombinedIcon, DollarSignIcon, KeyRoundIcon, LogsIcon, LogOutIcon, RouteIcon, ServerIcon, SettingsIcon, ShieldCheckIcon, WalletCardsIcon } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useRouter } from "next/navigation"
import { useState } from "react"

import { LoadingSpinner } from "@/components/loading-spinner"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"

const navigationGroups = [
  {
    label: "Gateway",
    items: [
      { title: "Endpoint & Key", icon: KeyRoundIcon, href: "/dashboard" },
      { title: "Providers", icon: ServerIcon, href: "/dashboard/providers" },
      { title: "Codex Providers", icon: ShieldCheckIcon, href: "/dashboard/providers/codex" },
      { title: "Alias", icon: ArrowLeftRightIcon, href: "/dashboard/aliases" },
    ],
  },
  {
    label: "Analytics",
    items: [
      { title: "Usage", icon: ChartNoAxesCombinedIcon, href: "/dashboard/usage" },
      { title: "Budgets", icon: WalletCardsIcon, href: "/dashboard/budgets" },
      { title: "Model Pricing", icon: DollarSignIcon, href: "/dashboard/model-pricing" },
    ],
  },
  {
    label: "System",
    items: [
      { title: "Console Log", icon: LogsIcon, href: "/dashboard/logs" },
      { title: "Settings", icon: SettingsIcon, href: "/dashboard/settings" },
    ],
  },
]

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const router = useRouter()
  const pathname = usePathname()
  const [signingOut, setSigningOut] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" tooltip="RawRoute">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-slate-950 text-white"><RouteIcon className="size-4" /></div>
          <div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-semibold">RawRoute</span><span className="truncate text-xs">Native protocol gateway</span></div>
        </SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {navigationGroups.map((group) => <SidebarGroup key={group.label}><SidebarGroupLabel>{group.label}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>
          {group.items.map((item) => <SidebarMenuItem key={item.href}><SidebarMenuButton isActive={pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`))} tooltip={item.title} render={<Link href={item.href} prefetch={false} />}><item.icon /><span>{item.title}</span></SidebarMenuButton></SidebarMenuItem>)}
        </SidebarMenu></SidebarGroupContent></SidebarGroup>)}
      </SidebarContent>
      <SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton aria-busy={signingOut} disabled={signingOut} tooltip="Sign out" onClick={() => setLogoutOpen(true)}>{signingOut ? <LoadingSpinner /> : <LogOutIcon />}<span>{signingOut ? "Signing out..." : "Sign out"}</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu><AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Sign out?</AlertDialogTitle><AlertDialogDescription>Your dashboard session will end on this browser.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={signingOut}>Cancel</AlertDialogCancel><AlertDialogAction disabled={signingOut} onClick={async () => { setSigningOut(true); try { await fetch("/api/auth/logout", { method: "POST" }); router.push("/login"); router.refresh() } finally { setSigningOut(false) } }}>{signingOut && <LoadingSpinner />}Sign out</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></SidebarFooter>
    </Sidebar>
  )
}
