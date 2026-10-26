import { parse } from "yaml"

export function configMapping(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CLIProxy config must contain a mapping.")
  return value as Record<string, unknown>
}

/** Reject duplicate keys rather than validating a different listener than Go reads. */
export function parseConfig(contents: string): Record<string, unknown> {
  return configMapping(parse(contents, { uniqueKeys: true, merge: true, maxAliasCount: 100 }))
}
