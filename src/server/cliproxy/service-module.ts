/** Keep one process supervisor when Bun hot-reloads the application modules. */
const runtime = globalThis as typeof globalThis & { rawrouteCliproxyService?: Promise<typeof import("./service")> }
export function managedService() { return runtime.rawrouteCliproxyService ??= import("./service") }
