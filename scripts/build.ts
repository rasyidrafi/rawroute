import { rm } from "node:fs/promises"
import tailwind from "bun-plugin-tailwind"
import { assertBrowserBuildGraph, checkArchitecture } from "./check-architecture"

checkArchitecture()

await rm("dist", { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ["./apps/console/src/server/index.ts"],
  outdir: "./dist",
  plugins: [tailwind],
  target: "bun",
  splitting: true,
  minify: true,
  env: "disable",
  metafile: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
})

for (const message of result.logs) console.error(message)
if (!result.success) process.exit(1)
if (!result.metafile) throw new Error("Bun did not return the browser output dependency graph")
console.log("Browser output boundaries verified:", assertBrowserBuildGraph(result.metafile))
const migration = await Bun.build({ entrypoints: ["./scripts/migrations/usage-projection.ts", "./scripts/migrations/aliases-to-combos.ts", "./scripts/migrations/storage.ts", "./scripts/migrations/model-share-conditions.ts", "./scripts/migrations/codex-credentials.ts", "./scripts/predict-missing-usage-cost.ts"], outdir: "./dist", target: "bun", minify: true, env: "disable" })
for (const message of migration.logs) console.error(message)
if (!migration.success) process.exit(1)
console.log(`Built ${result.outputs.length + migration.outputs.length} production files in dist/`)
