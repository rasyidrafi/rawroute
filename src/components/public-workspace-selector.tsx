"use client"

import { useRouter } from "next/navigation"

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select"

export function PublicWorkspaceSelector({ workspaces, workspaceId }: { workspaces: Array<{ id: string; name: string }>; workspaceId: string }) {
  const router = useRouter()
  return <Select value={workspaceId} onValueChange={(value) => {
    if (!value) return
    router.replace(value === "default" ? "/" : `/?workspace=${encodeURIComponent(value)}`)
  }}>
    <SelectTrigger aria-label="Workspace" className="h-9 w-[190px]"><span className="truncate">{workspaces.find((workspace) => workspace.id === workspaceId)?.name || "Default"}</span></SelectTrigger>
    <SelectContent><SelectGroup><SelectLabel>Workspace</SelectLabel>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>
}
