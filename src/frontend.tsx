import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { configureBrowserTimeZone } from "@/lib/timezone"
import "./index.css"

const element = document.getElementById("root")!

try {
  const response = await fetch("/api/config", { cache: "no-store" })
  if (!response.ok) throw new Error("Application configuration is unavailable.")
  const config = await response.json() as { timeZone: string }
  configureBrowserTimeZone(config.timeZone)
  const root = import.meta.hot ? (import.meta.hot.data.root ??= createRoot(element)) : createRoot(element)
  root.render(<StrictMode><ThemeProvider><TooltipProvider><App /><Toaster richColors /></TooltipProvider></ThemeProvider></StrictMode>)
} catch {
  element.textContent = "RawRoute could not connect to the server. Reload the page to try again."
}
