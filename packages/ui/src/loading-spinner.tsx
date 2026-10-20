import { LoaderCircleIcon } from "lucide-react"

import { cn } from "./utils"

export function LoadingSpinner({ className }: { className?: string }) {
  return <LoaderCircleIcon aria-hidden="true" className={cn("animate-spin", className)} />
}
