import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // useSyncExternalStore uses the server snapshot during hydration, then
  // reads the browser snapshot once hydration is complete.
  const subscribe = React.useCallback((onStoreChange: () => void) => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    mql.addEventListener("change", onStoreChange)
    return () => mql.removeEventListener("change", onStoreChange)
  }, [])
  const getSnapshot = React.useCallback(() => window.innerWidth < MOBILE_BREAKPOINT, [])
  const getServerSnapshot = React.useCallback(() => false, [])

  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
