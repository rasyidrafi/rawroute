import * as React from "react"

import { cn } from "./utils"
import { ScrollArea } from "./scroll-area"

/** Disable the inner scroller when a parent ScrollArea owns both scroll axes. */
function Table({ className, scrollable = true, ...props }: React.ComponentProps<"table"> & { scrollable?: boolean }) {
  const table = <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
  if (!scrollable) return table
  return (
    <ScrollArea
      data-slot="table-container"
      className="relative min-w-0 max-w-full overflow-hidden"
      orientation="horizontal"
    >
      {table}
    </ScrollArea>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, variant = "default", ...props }: React.ComponentProps<"tr"> & { variant?: "default" | "error" | "disabled" | "static" }) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        variant === "error" && "bg-destructive/5",
        variant === "disabled" && "opacity-60",
        variant === "static" && "hover:bg-transparent",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, variant = "default", ...props }: React.ComponentProps<"th"> & { variant?: "default" | "sticky" | "sticky-action" }) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        variant === "sticky" && "sticky top-0 z-10 bg-card",
        variant === "sticky-action" && "sticky top-0 right-0 z-20 w-20 min-w-20 bg-card text-center",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, variant = "default", density = "default", text = "default", tone = "default", ...props }: React.ComponentProps<"td"> & {
  variant?: "default" | "muted" | "sticky-action"
  density?: "default" | "comfortable" | "compact" | "flush"
  text?: "default" | "code" | "code-truncate" | "label" | "numeric" | "small" | "mono"
  tone?: "default" | "muted"
}) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        variant === "muted" && "bg-muted/20",
        variant === "sticky-action" && "sticky right-0 z-10 w-20 min-w-20 bg-card text-center",
        density === "comfortable" && "px-4 py-4",
        density === "compact" && "px-3 py-2",
        density === "flush" && "px-0",
        text === "code" && "font-mono text-xs",
        text === "code-truncate" && "truncate font-mono text-xs",
        text === "label" && "font-medium",
        text === "numeric" && "tabular-nums",
        text === "small" && "text-xs",
        text === "mono" && "font-mono",
        tone === "muted" && "text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}

export function TableColumns({ columns }: { columns: Array<{ id: string; label?: React.ReactNode; className?: string; variant?: React.ComponentProps<typeof TableHead>["variant"] }> }) {
  return <TableHeader><TableRow>{columns.map((column) => <TableHead key={column.id} className={column.className} variant={column.variant}>{column.label}</TableHead>)}</TableRow></TableHeader>
}
