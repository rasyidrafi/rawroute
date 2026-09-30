import { cn } from "@/lib/utils"

function Skeleton({ className, shape = "default", tone = "default", ...props }: React.ComponentProps<"div"> & {
  shape?: "default" | "icon" | "tile"
  tone?: "default" | "console"
}) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", shape === "icon" && "rounded", shape === "tile" && "rounded-lg", tone === "console" && "bg-console-skeleton", className)}
      {...props}
    />
  )
}

export { Skeleton }
