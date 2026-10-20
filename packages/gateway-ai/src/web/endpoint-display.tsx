export function maskApiKey(key: string) {
  if (key.length <= 12) return `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 4))}`
  return `${key.slice(0, 7)}${"•".repeat(20)}${key.slice(-4)}`
}

export function EndpointValue() {
  return <code className="min-w-0 flex-1 truncate text-sm">{window.location.origin}/v1</code>
}
