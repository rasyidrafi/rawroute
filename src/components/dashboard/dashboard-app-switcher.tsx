"use client"

import { CheckIcon, ChevronDownIcon, Grid2X2Icon } from "lucide-react"
import Link from "next/link"
import { useState } from "react"

import { dashboardApps, type DashboardApp } from "@/components/dashboard/dashboard-apps"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

export function DashboardAppSwitcher({ activeApp, onSelect }: { activeApp: DashboardApp; onSelect: () => void }) {
  const [open, setOpen] = useState(false)
  const { isMobile, state } = useSidebar()

  function selectApp() {
    setOpen(false)
    onSelect()
  }

  return (
    <SidebarMenuItem>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<SidebarMenuButton size="lg" tooltip="Switch app" aria-label="Switch app" />}>
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg border bg-background"><activeApp.icon className="size-4" /></div>
          <div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-semibold">{activeApp.title}</span><span className="truncate text-xs text-muted-foreground">App</span></div>
          <Grid2X2Icon className="size-4 text-muted-foreground" />
          <ChevronDownIcon className="ml-auto size-4 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side={state === "collapsed" && !isMobile ? "right" : "bottom"}
          sideOffset={8}
          className="w-[min(22rem,calc(100vw-2rem))] gap-3 p-3"
        >
          <PopoverHeader>
            <PopoverTitle>Switch app</PopoverTitle>
            <PopoverDescription>Choose the product workspace to open.</PopoverDescription>
          </PopoverHeader>
          <div className="grid grid-cols-2 gap-2" aria-label="Available apps">
            {dashboardApps.map((app) => {
              const isActive = app.id === activeApp.id

              return <Link
                key={app.id}
                href={app.href}
                prefetch={false}
                aria-label={app.title}
                aria-current={isActive ? "page" : undefined}
                onClick={selectApp}
                className={cn(
                  "group relative flex min-h-32 flex-col rounded-lg border p-3 text-left outline-hidden transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  isActive && "border-primary/30 bg-accent"
                )}
              >
                <div className="flex items-start justify-between gap-2"><div className="flex size-9 items-center justify-center rounded-md border bg-background"><app.icon className="size-4" /></div>{isActive && <CheckIcon className="size-4 text-primary" aria-hidden="true" />}</div>
                <span className="mt-3 font-medium">{app.title}</span>
                <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{app.description}</span>
              </Link>
            })}
          </div>
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  )
}
