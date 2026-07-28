"use client"

import { LaptopIcon, MoonIcon, SunIcon } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  return <DropdownMenu><DropdownMenuTrigger render={<Button aria-label="Change color theme" size="icon-sm" variant="ghost" />}><SunIcon className="size-4 dark:hidden" /><MoonIcon className="hidden size-4 dark:block" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={theme || "system"} onValueChange={setTheme}><DropdownMenuRadioItem value="light"><SunIcon />Light</DropdownMenuRadioItem><DropdownMenuRadioItem value="dark"><MoonIcon />Dark</DropdownMenuRadioItem><DropdownMenuRadioItem value="system"><LaptopIcon />System</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
}
