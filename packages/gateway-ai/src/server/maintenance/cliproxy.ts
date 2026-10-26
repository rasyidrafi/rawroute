/** Offline stopped-writer tools only. Not a console runtime integration API. */
export { ensureLayout, getServicePaths, writeAtomic, validateLoopbackConfig } from "../cliproxy/store"
export { configMapping, parseConfig } from "../cliproxy/config"
export { readState, writeState } from "../cliproxy/store"
export { prepareVersion, setCurrentVersion } from "../cliproxy/version-store"
