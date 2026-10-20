import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { ThemeProvider } from "@rawroute/platform/web/theme-provider"
import { Toaster } from "@rawroute/platform/web/toaster"
import { TooltipProvider } from "@rawroute/ui/tooltip"
import "./index.css"

const element = document.getElementById("root")!

const root = import.meta.hot ? (import.meta.hot.data.root ??= createRoot(element)) : createRoot(element)
root.render(<StrictMode><ThemeProvider><TooltipProvider><App /><Toaster richColors /></TooltipProvider></ThemeProvider></StrictMode>)
