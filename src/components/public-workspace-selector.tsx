import { useNavigate } from "react-router"

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select"

export function PublicWorkspaceSelector({ workspaces, workspaceId }: { workspaces: Array<{ id: string; name: string }>; workspaceId: string }) {
  const navigate = useNavigate()
  return <Select value={workspaceId} onValueChange={(value) => {
    if (!value) return
    navigate(value === "default" ? "/" : `/?workspace=${encodeURIComponent(value)}`, { replace: true })
  }}>
    <SelectTrigger aria-label="Workspace" className="h-8 w-[190px]"><span className="truncate">{workspaces.find((workspace) => workspace.id === workspaceId)?.name || "Default"}</span></SelectTrigger>
    <SelectContent><SelectGroup><SelectLabel>Workspace</SelectLabel>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>
}
