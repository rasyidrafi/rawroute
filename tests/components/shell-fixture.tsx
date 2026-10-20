import type { ReactNode } from "react"
import { ShellCompositionProvider, type ShellComposition } from "../../packages/platform/src/web/shell-composition"

export const shellFixture: ShellComposition = {
  apps: [], defaultLanding: "/dashboard/ai/overview", pageForPath: () => undefined,
  renderSkeleton: () => null, events: null, availability: {},
  wrapDashboard: children => children,
  workspaceChanged: () => undefined, reportCopy: () => undefined,
}
export function ShellFixture({ children }: { children: ReactNode }) {
  return <ShellCompositionProvider value={shellFixture}>{children}</ShellCompositionProvider>
}
