import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react"

type Theme = "light" | "dark" | "system"
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: string) => void } | undefined>(undefined)

function savedTheme(): Theme {
  try {
    const value = localStorage.getItem("theme")
    if (value === "light" || value === "dark") return value
  } catch {}
  return "system"
}

function subscribeSystemTheme(onChange: () => void) {
  const query = window.matchMedia("(prefers-color-scheme: dark)")
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, updateTheme] = useState<Theme>(savedTheme)
  const systemDark = useSyncExternalStore(subscribeSystemTheme, () => window.matchMedia("(prefers-color-scheme: dark)").matches, () => false)
  const dark = theme === "dark" || (theme === "system" && systemDark)

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    document.documentElement.classList.toggle("light", !dark)
    document.documentElement.style.colorScheme = dark ? "dark" : "light"
  }, [dark])

  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === "theme" || event.key === null) updateTheme(savedTheme()) }
    window.addEventListener("storage", sync)
    return () => window.removeEventListener("storage", sync)
  }, [])

  function setTheme(value: string) {
    if (value !== "light" && value !== "dark" && value !== "system") return
    updateTheme(value)
    try { localStorage.setItem("theme", value) } catch {}
  }

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error("useTheme must be used inside ThemeProvider")
  return context
}
