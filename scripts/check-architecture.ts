import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import ts from "typescript"

type Manifest = { name: string; exports?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
type Workspace = { directory: string; manifest: Manifest }
export const repository = resolve(import.meta.dir, "..")
export function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? productionFiles(file) : /\.(tsx?|css|html)$/.test(file) && !/\.(test|fixture)\.tsx?$/.test(file) ? [file] : []
  })
}
const browserExternal = new Set(["react", "react-dom", "react-router", "lucide-react", "swr", "sonner", "class-variance-authority", "clsx", "cmdk", "recharts", "tailwind-merge", "date-fns", "react-day-picker", "@legendapp/list", "@dnd-kit/core", "@dnd-kit/modifiers", "@dnd-kit/sortable", "@dnd-kit/utilities", "zod", "@base-ui/react", "@fontsource-variable/plus-jakarta-sans", "@fontsource/ibm-plex-mono", "tailwindcss", "tw-animate-css", "shadcn"])
const packageName = (specifier: string) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!
const inside = (file: string, directory: string) => file.startsWith(directory + sep)

/** Resolved source graph, not import-prefix heuristics. Overrides power negative fixtures. */
export function checkArchitecture(options: { root?: string; overrides?: Map<string, string>; manifests?: Map<string, Manifest> } = {}) {
  const root = options.root ?? repository
  const read = (file: string) => options.overrides?.get(file) ?? readFileSync(file, "utf8")
  const workspaces: Workspace[] = ["apps", "packages"].flatMap(group => readdirSync(join(root, group)).map(name => {
    const directory = join(root, group, name)
    const manifest = options.manifests?.get(directory) ?? JSON.parse(read(join(directory, "package.json"))) as Manifest
    return { directory, manifest }
  }))
  const byName = new Map(workspaces.map(workspace => [workspace.manifest.name, workspace]))
  const rootManifest = JSON.parse(read(join(root, "package.json"))) as Manifest
  if (rootManifest.exports) throw new Error("Mixed root package exports are forbidden")
  const tooling: Workspace = { directory: root, manifest: rootManifest }
  const owner = (file: string) => workspaces.find(workspace => inside(file, workspace.directory)) ?? (inside(file, join(root, "scripts")) ? tooling : undefined)
  const dag = new Map<string, string[]>()
  const direction: Record<string, readonly string[]> = {
    "@rawroute/ui": [], "@rawroute/observability": [],
    "@rawroute/platform": ["@rawroute/ui", "@rawroute/observability"],
    "@rawroute/gateway-ai": ["@rawroute/platform", "@rawroute/ui", "@rawroute/observability"],
    "@rawroute/gateway-tools": ["@rawroute/platform", "@rawroute/ui", "@rawroute/observability"],
    "@rawroute/gateway-storage": ["@rawroute/platform", "@rawroute/ui", "@rawroute/observability"],
    "@rawroute/console": ["@rawroute/platform", "@rawroute/ui", "@rawroute/observability", "@rawroute/gateway-ai", "@rawroute/gateway-tools", "@rawroute/gateway-storage"],
  }
  function fail(message: string): never { throw new Error(message) }
  for (const { directory, manifest } of workspaces) {
    if (!direction[manifest.name]) fail(`Unknown workspace ${manifest.name}: declare its dependency direction`)
    if (manifest.exports) for (const [key, target] of Object.entries(manifest.exports)) {
      if (key === "." || key.includes("*") || target.includes("*") || !target.startsWith("./src/")) fail(`Mixed root or wildcard export: ${manifest.name} ${key}`)
      const file = resolve(directory, target)
      if (!inside(file, join(directory, "src")) || !existsSync(file) || /\.(test|fixture)\./.test(file)) fail(`Invalid exported source: ${manifest.name} ${key}`)
      if (manifest.name !== "@rawroute/ui" && !/^\.\/(contracts|server|web)(\/|$)/.test(key)) fail(`Export requires explicit runtime layer: ${manifest.name} ${key}`)
      if (manifest.name !== "@rawroute/ui" && key.split("/")[1] !== relative(join(directory, "src"), file).split(sep)[0]) fail(`Export layer mismatch: ${key}`)
    }
    const edges = Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith("@rawroute/"))
    for (const name of edges) if (!byName.has(name) || !direction[manifest.name]!.includes(name)) fail(`Wrong-direction dependency: ${manifest.name} -> ${name}`)
    dag.set(manifest.name, edges)
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  function visit(name: string) {
    if (visiting.has(name)) fail(`Workspace dependency cycle: ${name}`)
    if (visited.has(name)) return
    visiting.add(name)
    for (const next of dag.get(name) ?? []) visit(next)
    visiting.delete(name); visited.add(name)
  }
  for (const name of dag.keys()) visit(name)
  const tsconfig = JSON.parse(read(join(root, "tsconfig.json"))) as { compilerOptions?: { paths?: Record<string, string[]> } }
  // shadcn needs a directory marker for adding primitives. It is NOT a valid
  // package import: every production specifier still resolves through exports.
  for (const [alias, targets] of Object.entries(tsconfig.compilerOptions?.paths ?? {})) {
    if (alias !== "@rawroute/ui" || JSON.stringify(targets) !== '["./packages/ui/src"]') fail("Production aliases bypass package exports")
  }
  const files = [...workspaces.flatMap(workspace => productionFiles(join(workspace.directory, "src"))), ...productionFiles(join(root, "scripts"))]
  const graph = new Map<string, string[]>(), externals = new Map<string, string[]>(), globals = new Map<string, string[]>()
  function resolveFile(base: string) {
    return [base, base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")].find(file => existsSync(file) && statSync(file).isFile())
  }
  for (const file of files) {
    const workspace = owner(file)!, imports: string[] = [], serverGlobals: string[] = []
    const text = read(file)
    if (/\.(css|html)$/.test(file)) {
      for (const match of text.matchAll(/(?:@import\s*|(?:src|href)=)["']([^"']+)["']/g)) if (!match[1]!.startsWith("/")) imports.push(match[1]!)
    } else {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      function walk(node: ts.Node) {
        if (ts.isIdentifier(node) && ["Bun", "Buffer", "process", "__dirname", "__filename"].includes(node.text)) serverGlobals.push(node.text)
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) imports.push(node.argument.literal.text)
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) {
          const argument = node.arguments[0]
          if (!argument || !ts.isStringLiteral(argument)) fail(`Non-static dependency: ${relative(root, file)}`)
          imports.push(argument.text)
        }
        ts.forEachChild(node, walk)
      }
      walk(source)
    }
    const edges: string[] = [], external: string[] = []
    for (const specifier of imports) {
      if (/^(https?:|data:)/.test(specifier) || /\.(html|css)$/.test(file) && specifier.startsWith("#")) continue
      let target: string | undefined
      if (specifier.startsWith(".")) {
        target = resolveFile(resolve(dirname(file), specifier))
        if (!target) fail(`Unresolved relative dependency: ${relative(root, file)} -> ${specifier}`)
        if (owner(target) !== workspace) fail(`Cross-package relative bypass: ${relative(root, file)} -> ${specifier}`)
      } else {
        const name = packageName(specifier), dependency = byName.get(name)
        if (specifier.startsWith("@/") || specifier.startsWith("/") || specifier.startsWith("#")) fail(`Alias or absolute bypass: ${specifier}`)
        if (dependency) {
          if (workspace !== dependency && !workspace.manifest.dependencies?.[name] && !(workspace === tooling && workspace.manifest.devDependencies?.[name])) fail(`Undeclared workspace dependency: ${workspace.manifest.name} -> ${name}`)
          const subpath = "." + specifier.slice(name.length)
          const exported = dependency.manifest.exports?.[subpath]
          if (!exported) fail(`Private package import: ${specifier}`)
          target = resolveFile(resolve(dependency.directory, exported))
          if (!target) fail(`Unresolved package export: ${specifier}`)
          if (workspace.manifest.name === "@rawroute/console" && name.startsWith("@rawroute/gateway-") && /\/server(?:\/|$)/.test(specifier) && !["./server", "./server/integration", "./server/routes", "./server/logging"].includes(subpath)) fail(`Console raw domain import: ${specifier}`)
        } else {
          if (!specifier.startsWith("node:") && !specifier.startsWith("bun:") && specifier !== "bun" && !builtinModules.includes(specifier) && !workspace.manifest.dependencies?.[name] && !(workspace === tooling && workspace.manifest.devDependencies?.[name])) fail(`Undeclared external dependency: ${workspace.manifest.name} -> ${name}`)
          external.push(specifier)
        }
      }
      if (target) edges.push(target)
    }
    graph.set(file, edges); externals.set(file, external); globals.set(file, serverGlobals)
  }
  const layer = (file: string) => relative(join(owner(file)!.directory, "src"), file).split(sep)[0]
  const browserRoots = files.filter(file => owner(file)!.manifest.name === "@rawroute/ui" || ["web", "contracts", "frontend"].includes(layer(file)))
  const browserSeen = new Set<string>()
  function browser(file: string) {
    if (browserSeen.has(file)) return
    browserSeen.add(file)
    if (layer(file) === "server") fail(`Browser reaches server-only module: ${relative(root, file)}`)
    if (globals.get(file)?.length) fail(`Server-only global in browser: ${relative(root, file)} ${globals.get(file)!.join(",")}`)
    for (const specifier of externals.get(file) ?? []) if (!browserExternal.has(packageName(specifier))) fail(`Browser reaches server-only external: ${specifier}`)
    for (const next of graph.get(file) ?? []) browser(next)
  }
  for (const file of browserRoots) browser(file)
  // Every server branch and contracts subtree is checked, including re-exports and dynamic imports.
  for (const file of files) for (const next of graph.get(file) ?? []) {
    if (layer(file) === "server" && ["web", "frontend"].includes(layer(next)) && !inside(next, join(root, "apps/console/src/frontend/contracts")) && !/\.(css|html)$/.test(next)) fail(`Server imports browser implementation: ${relative(root, file)} -> ${relative(root, next)}`)
    if (layer(file) === "contracts" && !["contracts"].includes(layer(next))) fail(`Contracts import implementation: ${relative(root, file)} -> ${relative(root, next)}`)
  }
  const serverSeen = new Set<string>()
  function server(file: string) {
    if (serverSeen.has(file) || /\.(html|css)$/.test(file)) return // Native Bun HTML is a browser entry boundary.
    serverSeen.add(file)
    if (["web", "frontend"].includes(layer(file)) && !inside(file, join(root, "apps/console/src/frontend/contracts"))) fail(`Server reaches browser implementation: ${relative(root, file)}`)
    for (const next of graph.get(file) ?? []) server(next)
  }
  for (const file of files.filter(file => layer(file) === "server")) server(file)
  return { workspaces: workspaces.length, files: files.length, browserFiles: browserSeen.size }
}

/** Validate the emitted browser chunk graph, including shared and lazy chunks. */
export function assertBrowserBuildGraph(meta: Bun.BuildMetafile, root = repository) {
  const entry = "apps/console/src/frontend/index.html"
  const normalize = (path: string) => resolve(root, path)
  const outputs = new Map(Object.entries(meta.outputs).map(([path, output]) => [normalize(path), output]))
  const pending = Object.entries(meta.outputs).filter(([, output]) => output.entryPoint && normalize(output.entryPoint) === normalize(entry)).map(([path]) => normalize(path))
  if (!pending.length) throw new Error("Browser build graph has no real HTML entrypoint")
  const seen = new Set<string>(), inputs = new Set<string>()
  while (pending.length) {
    const path = pending.pop()!
    if (seen.has(path)) continue
    seen.add(path)
    const output = outputs.get(path)
    if (!output) throw new Error(`Unresolved browser output chunk: ${path}`)
    for (const input of Object.keys(output.inputs)) {
      const file = normalize(input)
      inputs.add(file)
      const local = relative(root, file).split(sep)
      if ((local[0] === "packages" || local[0] === "apps") && local[2] === "src") {
        const allowed = local[0] === "packages" && local[1] === "ui" || ["web", "contracts", "frontend"].includes(local[3]!)
        if (!allowed) throw new Error(`Browser output contains server/private source: ${input}`)
      }
    }
    // Output imports are the emitted runtime edges. Bun's input metadata also
    // labels unused, tree-shaken library re-exports as external; those are not
    // shipped dependencies. Production source/type edges are checked above.
    for (const dependency of output.imports) {
      const target = normalize(dependency.path)
      if (!outputs.has(target)) throw new Error(`Browser output has unbundled/server-only dependency: ${dependency.path}`)
      pending.push(target)
    }
  }
  if (!inputs.has(normalize("apps/console/src/frontend/frontend.tsx"))) throw new Error("Browser build graph omits actual frontend bootstrap")
  return { chunks: seen.size, inputs: inputs.size }
}

if (import.meta.main) console.log("Architecture verified:", checkArchitecture())
