export function isMemoryBackend() {
  return process.env.STORAGE_BACKEND === "memory" || process.env.NODE_ENV === "test"
}

export function collectionPrefix() {
  return (process.env.DATABASE_COLLECTION_PREFIX || "rawroute").replace(/[^a-zA-Z0-9_-]/g, "_")
}
