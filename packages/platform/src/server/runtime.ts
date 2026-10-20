import { createIdentityRepository, type Meta } from "./identity"
import { createSessionAuthentication } from "./session"
import { createWorkspaceRepository } from "./workspace-repository"

export interface PlatformServerDependencies {
  identity: Parameters<typeof createIdentityRepository>[0]
  participants: Parameters<typeof createWorkspaceRepository>[0]["participants"]
}

declare global { var __rawrouteIdentityMemory: { value?: Meta } | undefined }

/** Configured by the executable before serving; gateways never import the executable. */
export function createPlatformServer(dependencies: PlatformServerDependencies) {
  const identity = createIdentityRepository(dependencies.identity)
  return { identity, ...createSessionAuthentication(identity.sign), ...createWorkspaceRepository({ participants: dependencies.participants }) }
}

let configured: ReturnType<typeof createPlatformServer> | undefined
export function configurePlatformServer(dependencies: PlatformServerDependencies) {
  configured = createPlatformServer({ ...dependencies, identity: { ...dependencies.identity, memory: dependencies.identity.memory ?? (globalThis.__rawrouteIdentityMemory ||= {}) } })
  return configured
}
function runtime() {
  if (!configured) throw new Error("Platform server must be configured before use.")
  return configured
}

type Runtime = ReturnType<typeof createPlatformServer>
export const readMeta: Runtime["identity"]["readMeta"] = (...args) => runtime().identity.readMeta(...args)
export const updateMeta: Runtime["identity"]["updateMeta"] = (...args) => runtime().identity.updateMeta(...args)
export const writeMeta: Runtime["identity"]["writeMeta"] = (...args) => runtime().identity.writeMeta(...args)
export const identity: Runtime["identity"] = {
  readMeta, updateMeta, writeMeta,
  sign: (...args) => runtime().identity.sign(...args),
  invalidate: () => runtime().identity.invalidate(),
  reset: () => runtime().identity.reset(),
}
export const createSession: Runtime["createSession"] = (...args) => runtime().createSession(...args)
export const destroySession: Runtime["destroySession"] = (...args) => runtime().destroySession(...args)
export const isAuthenticated: Runtime["isAuthenticated"] = (...args) => runtime().isAuthenticated(...args)
export const listWorkspaces: Runtime["listWorkspaces"] = (...args) => runtime().listWorkspaces(...args)
export const getPublicWorkspace: Runtime["getPublicWorkspace"] = (...args) => runtime().getPublicWorkspace(...args)
export const getWorkspace: Runtime["getWorkspace"] = (...args) => runtime().getWorkspace(...args)
export const createWorkspace: Runtime["createWorkspace"] = (...args) => runtime().createWorkspace(...args)
export const renameWorkspace: Runtime["renameWorkspace"] = (...args) => runtime().renameWorkspace(...args)
export const deleteWorkspace: Runtime["deleteWorkspace"] = (...args) => runtime().deleteWorkspace(...args)
export const recoverWorkspaceDeletions: Runtime["recoverWorkspaceDeletions"] = (...args) => runtime().recoverWorkspaceDeletions(...args)
export const resetWorkspacesForTests: Runtime["resetWorkspacesForTests"] = (...args) => runtime().resetWorkspacesForTests(...args)
