import type { LucideIcon } from "lucide-react"

export type NavigationItem = { page: string; title: string; icon: LucideIcon; href: string }
export type NavigationGroup = { label: string; items: NavigationItem[] }

export function navigationFor<const T extends Record<string, { path: string; title: string }>>(pages: T) {
  return (page: keyof T & string, icon: LucideIcon): NavigationItem => ({ page, title: pages[page].title, href: pages[page].path, icon })
}
