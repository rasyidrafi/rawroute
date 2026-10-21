/** Keep provider tier identifiers, not UI mode names, as the accounting key. */
export function normalizeServiceTier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const tier = value.trim().toLowerCase()
  return /^[a-z][a-z0-9_-]{0,63}$/.test(tier) ? tier : undefined
}

export function serviceTierLabel(tier: string) {
  return ({ default: "Standard", standard: "Standard", priority: "Fast", ultrafast: "Ultrafast", flex: "Flex", auto: "Auto" } as Record<string, string>)[tier] || tier
}
