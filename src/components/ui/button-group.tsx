import * as React from "react"

import { cn } from "@/lib/utils"

function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="button-group"
      role="group"
      className={cn(
        "inline-flex w-fit items-center rounded-lg [&>[data-slot=button]]:rounded-none [&>[data-slot=button]]:shadow-none [&>[data-slot=button]:first-child]:rounded-l-lg [&>[data-slot=button]:focus-visible]:z-10 [&>[data-slot=button]:last-child]:rounded-r-lg [&>[data-slot=button]:not(:first-child)]:border-l-0",
        className
      )}
      {...props}
    />
  )
}

export { ButtonGroup }
