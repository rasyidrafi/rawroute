import { importLegacyInstance } from "../src/server/cliproxy/migration"

const [source, destination] = process.argv.slice(2)
if (!source || !destination) throw new Error("Usage: bun scripts/import-cliproxy.ts <stopped-legacy-directory> <new-data-directory>. Source must contain config.yaml and auths/; logs/ and plugins/ are optional.")
await importLegacyInstance(source, destination)
console.log("CLIProxy configuration and credentials imported. Original data was preserved.")
