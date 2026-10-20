import type { Workspace } from "./workspace"

/** Verified credential owner, independent of the gateway's credential storage. */
export interface GatewayRequestIdentity {
  workspace: Workspace
  credentialId: string
}

export type GatewayAuthentication = (request: Request) => Promise<GatewayRequestIdentity | undefined>

/** Capability supplied by composition; never exposes signing key material. */
export type SignValue = (value: string) => Promise<string>
