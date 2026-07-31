"use client"

import { usePathname } from "next/navigation"

import { ThemeToggle } from "@/components/theme-toggle"
import { SidebarTrigger } from "@/components/ui/sidebar"

export function SiteHeader() {
  const pathname = usePathname()
  const title = pathname.startsWith("/dashboard/providers") ? "Providers" : pathname.startsWith("/dashboard/oauth-providers") ? "OAuth Providers" : pathname === "/dashboard/logs" ? "Console Log" : pathname === "/dashboard/settings" ? "Settings" : "Endpoint & Key"

  return <header className="sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center border-b bg-background/90 backdrop-blur-md"><div className="flex w-full items-center gap-3 px-4 lg:px-6"><SidebarTrigger className="-ml-1" /><h1 className="font-medium">{title}</h1><div className="ml-auto"><ThemeToggle /></div></div></header>
}
