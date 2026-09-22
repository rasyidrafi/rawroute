"use client"

import { ChevronDownIcon, LogOutIcon, PencilIcon, PlusIcon, RouteIcon, Trash2Icon } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { apiDelete, apiPatch, apiPost } from "@/components/dashboard/api"
import { dashboardAppForPathname, dashboardApps, isDashboardNavigationItemActive } from "@/components/dashboard/dashboard-apps"
import { useToolGatewayStatus } from "@/components/dashboard/tool-gateway-status"
import { useWorkspace } from "@/components/dashboard/workspace-provider"
import { LoadingSpinner } from "@/components/loading-spinner"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const router = useRouter()
  const pathname = usePathname()
  const activeApp = dashboardAppForPathname(pathname)
  const { isMobile, setOpenMobile } = useSidebar()
  const { workspaces, workspace, selectWorkspace, refreshWorkspaces } = useWorkspace()
  const { data: toolGatewayStatus } = useToolGatewayStatus()
  const toolGatewayAvailable = toolGatewayStatus?.state === "available"
  const [signingOut, setSigningOut] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [name, setName] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [workspacePending, setWorkspacePending] = useState(false)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)

  useEffect(() => {
    if (isMobile) setOpenMobile(false)
  }, [isMobile, pathname, setOpenMobile])

  function closeMobileSidebar() {
    if (isMobile) setOpenMobile(false)
  }

  function switchWorkspace(workspaceId: string) {
    setWorkspaceMenuOpen(false)
    closeMobileSidebar()
    selectWorkspace(workspaceId)
    if (pathname.startsWith("/dashboard/providers/") && pathname !== "/dashboard/providers/codex") router.push("/dashboard/providers")
    else router.refresh()
  }

  function switchApp(appId: string) {
    const app = dashboardApps.find((entry) => entry.id === appId)
    setWorkspaceMenuOpen(false)
    closeMobileSidebar()
    if (!app || app.id === activeApp.id || (app.id === "tool-gateway" && !toolGatewayAvailable)) return
    router.push(app.href)
  }

  async function createNewWorkspace() {
    setWorkspacePending(true)
    try {
      const response = await apiPost<{ workspace: { id: string } }>("/api/admin/workspaces", { name })
      await refreshWorkspaces()
      switchWorkspace(response.workspace.id)
      setCreateOpen(false)
      setName("")
      toast.success("Workspace created")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to create workspace") }
    finally { setWorkspacePending(false) }
  }

  async function renameCurrentWorkspace() {
    setWorkspacePending(true)
    try {
      await apiPatch(`/api/admin/workspaces/${workspace.id}`, { name })
      await refreshWorkspaces()
      setRenameOpen(false)
      setName("")
      toast.success("Workspace renamed")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to rename workspace") }
    finally { setWorkspacePending(false) }
  }

  async function deleteCurrentWorkspace() {
    setWorkspacePending(true)
    try {
      await apiDelete(`/api/admin/workspaces/${workspace.id}`, { confirmation })
      selectWorkspace("default")
      await refreshWorkspaces()
      router.push("/dashboard")
      setDeleteOpen(false)
      setConfirmation("")
      toast.success("Workspace deleted")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to delete workspace") }
    finally { setWorkspacePending(false) }
  }

  return (
    <><Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu open={workspaceMenuOpen} onOpenChange={setWorkspaceMenuOpen}>
              <DropdownMenuTrigger render={<SidebarMenuButton size="lg" tooltip={`${workspace.name} • ${activeApp.title}`} />}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-slate-950 text-white"><RouteIcon className="size-4" /></div>
                <div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-semibold">RawRoute</span><span className="flex min-w-0 items-center truncate text-xs"><span className="truncate">{workspace.name}</span><span aria-hidden="true" className="px-1 text-muted-foreground">•</span><span className="sr-only"> in </span><span className="truncate">{activeApp.title}</span></span></div>
                <ChevronDownIcon className="ml-auto size-4 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64" align="start" side={isMobile ? "bottom" : "right"} sideOffset={4}>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={workspace.id} onValueChange={switchWorkspace}>
                    {workspaces.map((entry) => <DropdownMenuRadioItem key={entry.id} value={entry.id}><div className="flex size-7 items-center justify-center rounded-md border bg-background"><RouteIcon className="size-3.5" /></div><span>{entry.name}</span></DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuItem onClick={() => { setName(""); setCreateOpen(true) }}><div className="flex size-7 items-center justify-center rounded-md border bg-background"><PlusIcon className="size-4" /></div><span>Add New Workspace</span></DropdownMenuItem>
                  <DropdownMenuItem disabled={workspace.isDefault} onClick={() => { setName(workspace.name); setRenameOpen(true) }}><div className="flex size-7 items-center justify-center rounded-md border bg-background"><PencilIcon className="size-4" /></div><span>Rename Workspace</span></DropdownMenuItem>
                  <DropdownMenuItem disabled={workspace.isDefault} variant="destructive" onClick={() => { setConfirmation(""); setDeleteOpen(true) }}><div className="flex size-7 items-center justify-center rounded-md border bg-background"><Trash2Icon className="size-4" /></div><span>Delete Workspace</span></DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Apps</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={activeApp.id} onValueChange={switchApp}>
                    {dashboardApps.map((app) => {
                      const unavailable = app.id === "tool-gateway" && !toolGatewayAvailable
                      const statusLabel = !toolGatewayStatus
                        ? "Checking"
                        : toolGatewayStatus.state === "disabled" ? "Not configured" : "Unavailable"
                      return <DropdownMenuRadioItem key={app.id} value={app.id} disabled={unavailable} title={unavailable ? statusLabel : undefined}>
                        <div className="flex size-7 items-center justify-center rounded-md border bg-background"><app.icon className="size-3.5" /></div>
                        <span className="min-w-0 flex-1 truncate">{app.title}</span>
                        {unavailable && <span className="mr-1 text-[10px] text-muted-foreground">{statusLabel}</span>}
                      </DropdownMenuRadioItem>
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {activeApp.navigation.map((group) => <SidebarGroup key={group.label}><SidebarGroupLabel>{group.label}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>
          {group.items.map((item) => <SidebarMenuItem key={item.href}><SidebarMenuButton isActive={isDashboardNavigationItemActive(pathname, item)} tooltip={item.title} onClick={closeMobileSidebar} render={<Link href={item.href} prefetch={false} aria-current={isDashboardNavigationItemActive(pathname, item) ? "page" : undefined} />}><item.icon /><span>{item.title}</span></SidebarMenuButton></SidebarMenuItem>)}
        </SidebarMenu></SidebarGroupContent></SidebarGroup>)}
      </SidebarContent>
      <SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton aria-busy={signingOut} disabled={signingOut} tooltip="Sign out" onClick={() => { closeMobileSidebar(); setLogoutOpen(true) }}>{signingOut ? <LoadingSpinner /> : <LogOutIcon />}<span>{signingOut ? "Signing out..." : "Sign out"}</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu><AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Sign out?</AlertDialogTitle><AlertDialogDescription>Your dashboard session will end on this browser.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={signingOut}>Cancel</AlertDialogCancel><AlertDialogAction disabled={signingOut} onClick={async () => { setSigningOut(true); try { await fetch("/api/auth/logout", { method: "POST" }); router.push("/login"); router.refresh() } finally { setSigningOut(false) } }}>{signingOut && <LoadingSpinner />}Sign out</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></SidebarFooter>
    </Sidebar>
    <Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent><form onSubmit={(event) => { event.preventDefault(); void createNewWorkspace() }}><DialogHeader><DialogTitle>Create workspace</DialogTitle><DialogDescription>New workspaces start empty and use completely isolated data.</DialogDescription></DialogHeader><div className="py-5"><label htmlFor="workspace-create-name" className="text-sm font-medium">Workspace name</label><Input id="workspace-create-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus className="mt-2" /></div><DialogFooter><Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={workspacePending}>Cancel</Button><Button type="submit" disabled={!name.trim() || workspacePending}>{workspacePending && <LoadingSpinner />}Create</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={renameOpen} onOpenChange={setRenameOpen}><DialogContent><form onSubmit={(event) => { event.preventDefault(); void renameCurrentWorkspace() }}><DialogHeader><DialogTitle>Rename workspace</DialogTitle><DialogDescription>The workspace ID and all API keys remain unchanged.</DialogDescription></DialogHeader><div className="py-5"><label htmlFor="workspace-rename-name" className="text-sm font-medium">Workspace name</label><Input id="workspace-rename-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus className="mt-2" /></div><DialogFooter><Button type="button" variant="outline" onClick={() => setRenameOpen(false)} disabled={workspacePending}>Cancel</Button><Button type="submit" disabled={!name.trim() || workspacePending}>{workspacePending && <LoadingSpinner />}Save</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogContent><form onSubmit={(event) => { event.preventDefault(); void deleteCurrentWorkspace() }}><DialogHeader><DialogTitle>Delete {workspace.name}?</DialogTitle><DialogDescription>This permanently removes its keys, providers, models, usage, budgets, and pricing. Type the workspace name to confirm.</DialogDescription></DialogHeader><div className="py-5"><label htmlFor="workspace-delete-confirmation" className="text-sm font-medium">Type {workspace.name}</label><Input id="workspace-delete-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoFocus className="mt-2" /></div><DialogFooter><Button type="button" variant="outline" onClick={() => setDeleteOpen(false)} disabled={workspacePending}>Cancel</Button><Button type="submit" variant="destructive" disabled={confirmation !== workspace.name || workspacePending}>{workspacePending && <LoadingSpinner />}Delete permanently</Button></DialogFooter></form></DialogContent></Dialog>
    </>
  )
}
