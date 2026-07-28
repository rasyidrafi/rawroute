import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

export function SiteHeader() {
  return <header className="flex h-(--header-height) shrink-0 items-center border-b bg-background/80 backdrop-blur"><div className="flex w-full items-center gap-2 px-4 lg:px-6"><SidebarTrigger className="-ml-1" /><Separator orientation="vertical" className="mx-1 h-4" /><h1 className="font-medium">Gateway control plane</h1><Badge variant="outline" className="ml-auto gap-1.5"><span className="size-1.5 rounded-full bg-emerald-500" />Online</Badge></div></header>
}
