import { test } from "bun:test"
import { runInWorkspace } from "../../packages/platform/src/server/workspace-context"

/** Explicit fixture selection for domain tests; global/security tests stay unscoped. */
export function testsInWorkspace(workspaceId: string) {
  return (name: string, callback: () => unknown) => test(name, async () => {
    await runInWorkspace({ id: workspaceId }, callback)
  })
}
