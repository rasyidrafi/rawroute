import type { ToasterProps } from "sonner"
import { Toaster as ToastSurface } from "@rawroute/ui/sonner"
import { useTheme } from "./theme-provider"

export function Toaster(props: ToasterProps) {
  const { theme } = useTheme()
  return <ToastSurface theme={theme} {...props} />
}
