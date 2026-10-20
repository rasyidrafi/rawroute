import { cn } from "./utils"

function Skeleton({ className, shape = "default", tone = "default", motion = "default", ...props }: React.ComponentProps<"div"> & {
  shape?: "default" | "icon" | "tile" | "pill"
  tone?: "default" | "console"
  motion?: "default" | "respect-preference"
}) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", shape === "icon" && "rounded", shape === "tile" && "rounded-lg", shape === "pill" && "rounded-full", tone === "console" && "bg-console-skeleton", motion === "respect-preference" && "motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
