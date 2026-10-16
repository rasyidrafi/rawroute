import { useLayoutEffect } from "react"
import { useLocation } from "react-router"

/** Page navigation starts at the top; same-page filters keep their position. */
export function RouteScrollReset() {
  const { pathname } = useLocation()
  useLayoutEffect(() => {
    const previous = window.history.scrollRestoration
    window.history.scrollRestoration = "manual"
    return () => { window.history.scrollRestoration = previous }
  }, [])
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" })
  }, [pathname])
  return null
}
