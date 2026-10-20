export function cleanId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

export function cleanAliasId(value: string) {
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
}

export function gatewayModelId(prefix: string, suffix: string) {
  const cleanSuffix = cleanId(suffix.includes("/") ? suffix.slice(suffix.lastIndexOf("/") + 1) : suffix)
  if (!cleanSuffix) throw new Error("Gateway model ID is required.")
  return `${cleanId(prefix)}/${cleanSuffix}`
}
