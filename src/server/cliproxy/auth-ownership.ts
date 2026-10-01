import * as fs from "node:fs"
import * as path from "node:path"
import { cliproxyMode } from "./connection"
import { getDataRoot, getServicePaths } from "./store"

/** CLIProxy 7.3.4 does not include prefixes in every management listing. */
export function hasManagedAuthPrefix(name: unknown): boolean {
  if (cliproxyMode() !== "managed") return false
  // Ambiguous local ownership fails closed. No credential fields leave this function.
  if (typeof name !== "string" || !name || /[/\\\0\r\n]/.test(name) || name === "." || name === "..") return true
  try {
    const file = path.join(getServicePaths(getDataRoot()).auth, name)
    const info = fs.lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return true
    const metadata = JSON.parse(fs.readFileSync(file, "utf8")) as { prefix?: unknown }
    return typeof metadata.prefix === "string" && metadata.prefix.startsWith("rr-codex-")
  } catch { return true }
}
