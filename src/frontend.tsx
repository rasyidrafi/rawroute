import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import "./index.css"

const element = document.getElementById("root")!

const root = import.meta.hot ? (import.meta.hot.data.root ??= createRoot(element)) : createRoot(element)
root.render(<StrictMode><ThemeProvider><TooltipProvider><App /><Toaster richColors /></TooltipProvider></ThemeProvider></StrictMode>)
