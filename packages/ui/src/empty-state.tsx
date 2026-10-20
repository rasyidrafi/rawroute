import type { ReactNode } from "react"
import { InboxIcon } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./empty"
import { cn } from "./utils"

export type EmptyStateProps = {
  title: string
  description: string
  icon?: LucideIcon
  action?: ReactNode
  variant?: "default" | "compact"
  treatment?: "card" | "embedded" | "table"
  tone?: "default" | "console"
  className?: string
}

function EmptyStateContent({ title, description, icon: Icon, compact, tone }: {
  title: string
  description: string
  icon: LucideIcon
  compact: boolean
  tone: "default" | "console"
}) {
  return <EmptyHeader className={cn("gap-2", compact && "gap-1.5")}>
    <EmptyMedia variant="icon" className={cn(
      "mb-0 size-14 rounded-full border border-border/70 bg-muted/35 text-muted-foreground [&_svg]:size-5",
      compact && "size-11 [&_svg]:size-4",
      tone === "console" && "border-console-muted/30 bg-console-skeleton text-console-muted",
    )}>
      <Icon aria-hidden="true" />
    </EmptyMedia>
    <EmptyTitle className={cn("text-base font-semibold", compact && "text-sm", tone === "console" && "text-console-foreground")}>{title}</EmptyTitle>
    <EmptyDescription className={cn("max-w-prose text-pretty", compact && "text-xs/relaxed", tone === "console" && "text-console-muted")}>{description}</EmptyDescription>
  </EmptyHeader>
}

export function EmptyState({ title, description, icon: Icon = InboxIcon, action, variant = "default", treatment = "card", tone = "default", className }: EmptyStateProps) {
  const compact = variant === "compact"

  return <Empty
    role="status"
    aria-live="polite"
    aria-atomic="true"
    data-slot="empty-state"
    data-variant={variant}
    data-treatment={treatment}
    data-tone={tone}
    className={cn(
      "gap-4",
      treatment === "card" && "min-h-56 rounded-xl border border-border/70 bg-card/90 p-8 sm:p-10",
      treatment === "embedded" && "min-h-36 rounded-none border-0 bg-transparent p-4",
      treatment === "table" && "min-h-32 rounded-none border-0 bg-transparent p-3",
      compact && treatment === "card" && "min-h-40 gap-3 p-5",
      compact && treatment === "embedded" && "min-h-28 gap-3 p-3",
      compact && treatment === "table" && "min-h-28 gap-3 p-3",
      className,
    )}
  >
    <EmptyStateContent title={title} description={description} icon={Icon} compact={compact} tone={tone} />
    {action && <EmptyContent className="flex-row justify-center">{action}</EmptyContent>}
  </Empty>
}
