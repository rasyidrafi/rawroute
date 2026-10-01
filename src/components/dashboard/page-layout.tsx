import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

export function DashboardPage({ children, className, spacing = "wide", width = "default", ...props }: ComponentProps<"main"> & { spacing?: "wide" | "normal" | "compact"; width?: "default" | "narrow" }) {
  return <main className={cn("flex-1 bg-workspace p-4 dark:bg-background md:p-6 lg:p-8", className)} {...props}>
    <div data-slot="page-content" className={cn("mx-auto flex min-w-0 flex-col", width === "narrow" ? "max-w-5xl" : "max-w-7xl", spacing === "compact" ? "gap-4" : spacing === "normal" ? "gap-6" : "gap-8")}>{children}</div>
  </main>
}

export const logPageClassName = "h-[calc(100svh-var(--header-height))] max-h-[calc(100svh-var(--header-height))] min-h-0 flex-none overflow-hidden bg-workspace p-4 dark:bg-background md:h-[calc(100svh-var(--header-height)-1rem)] md:max-h-[calc(100svh-var(--header-height)-1rem)] md:p-6 lg:p-8"
