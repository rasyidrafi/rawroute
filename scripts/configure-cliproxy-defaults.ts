import { convertCliProxyDefaults } from "./migrations/cliproxy-defaults"

// Stop RawRoute before --apply. The conversion creates a private backup first.
const file = process.argv.find(arg => arg.startsWith("--config="))?.slice("--config=".length)
if (!file) throw new Error("Usage: bun scripts/configure-cliproxy-defaults.ts --config=/path/config.yaml [--apply]")
console.log(JSON.stringify(convertCliProxyDefaults(file, process.argv.includes("--apply"))))
