import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { CheckIcon, SearchIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Command({ className, variant = "default", ...props }: React.ComponentProps<typeof CommandPrimitive> & { variant?: "default" | "embedded" }) {
  return <CommandPrimitive data-slot="command" className={cn("flex size-full flex-col overflow-hidden rounded-xl bg-popover p-1 text-popover-foreground", variant === "embedded" && "rounded-none p-0", className)} {...props} />
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return <div data-slot="command-input-wrapper" className="p-1 pb-0"><div className="relative flex h-8 items-center rounded-lg border border-input/30 bg-input/30"><SearchIcon className="pointer-events-none absolute left-2 size-4 shrink-0 opacity-50" /><CommandPrimitive.Input data-slot="command-input" className={cn("h-full w-full bg-transparent pl-8 pr-2 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} /></div></div>
}

function CommandList({ className, variant = "default", ...props }: React.ComponentProps<typeof CommandPrimitive.List> & { variant?: "default" | "padded" }) {
  return <CommandPrimitive.List data-slot="command-list" className={cn("max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none", variant === "padded" && "px-2 py-1", className)} {...props} />
}

function CommandEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty data-slot="command-empty" className={cn("py-6 text-center text-sm", className)} {...props} />
}

function CommandGroup({ className, variant = "default", ...props }: React.ComponentProps<typeof CommandPrimitive.Group> & { variant?: "default" | "flush" }) {
  return <CommandPrimitive.Group data-slot="command-group" className={cn("overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground", variant === "flush" && "p-0", className)} {...props} />
}

function CommandItem({ className, children, variant = "default", ...props }: React.ComponentProps<typeof CommandPrimitive.Item> & { variant?: "default" | "detail" }) {
  return <CommandPrimitive.Item data-slot="command-item" className={cn("group/command-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:bg-muted data-selected:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0", variant === "detail" && "items-start gap-3 rounded-md px-3 py-2", className)} {...props}>{children}<CheckIcon className="ml-auto opacity-0 group-data-[checked=true]/command-item:opacity-100" /></CommandPrimitive.Item>
}

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem }
