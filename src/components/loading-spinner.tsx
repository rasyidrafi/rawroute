import { LoaderCircleIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export function LoadingSpinner({ className }: { className?: string }) {
  return <LoaderCircleIcon aria-hidden="true" className={cn("animate-spin", className)} />
}
