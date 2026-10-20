import { identity } from "@rawroute/platform/server/runtime"
import type { SignValue } from "@rawroute/platform/contracts/request-identity"

// Preserve existing confirmation signatures while exposing only a capability.
export const signComboConfirmation: SignValue = identity.sign
