import * as React from "react"

import { cn } from "@/lib/utils"

function Card({
  className,
  size = "default",
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm"; variant?: "default" | "dashboard" | "summary" | "empty" | "login" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card flex min-w-0 max-w-full flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10 [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        variant === "dashboard" && "border-border/70 bg-card/95",
        variant === "summary" && "border-border/70 bg-card/95 shadow-sm",
        variant === "empty" && "border-dashed border-border/70 bg-card/90",
        variant === "login" && "border-border/70 shadow-2xl shadow-console/10",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, variant = "default", ...props }: React.ComponentProps<"div"> & { variant?: "default" | "spacious" }) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid min-w-0 max-w-full auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        variant === "spacious" && "space-y-5",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, variant = "default", ...props }: React.ComponentProps<"div"> & { variant?: "default" | "icon" | "metric" | "page" }) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "min-w-0 break-words font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        variant === "icon" && "flex items-center gap-2",
        variant === "metric" && "text-3xl tracking-tight",
        variant === "page" && "text-2xl",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("min-w-0 break-words text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 max-w-full self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, spacing = "default", ...props }: React.ComponentProps<"div"> & { spacing?: "default" | "stack" | "compact-stack" | "flow" | "compact-flow" }) {
  return (
    <div
      data-slot="card-content"
      className={cn("min-w-0 max-w-full overflow-x-auto px-(--card-spacing)", spacing === "stack" && "space-y-4", spacing === "compact-stack" && "space-y-3", spacing === "flow" && "gap-4", spacing === "compact-flow" && "gap-3", className)}
      {...props}
    />
  )
}

function CardFooter({ className, variant = "default", ...props }: React.ComponentProps<"div"> & { variant?: "default" | "detail" }) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex min-w-0 max-w-full items-center overflow-x-auto rounded-b-xl border-t bg-muted/50 p-(--card-spacing)",
        variant === "detail" && "text-xs text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
