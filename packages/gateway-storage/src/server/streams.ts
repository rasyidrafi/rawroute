import { createHash, timingSafeEqual } from "node:crypto"

export class StorageBodyError extends Error {
  constructor(readonly code: "EntityTooLarge" | "IncompleteBody" | "XAmzContentSHA256Mismatch") { super(code) }
}

/** Bounded, pull-driven stream; never reads ahead of the upstream consumer.
 * A signed body mismatch errors the stream and must abort the upstream request.
 * The caller must not retry a failed stream write.
 */
export function storageUploadBody(source: ReadableStream<Uint8Array>, options: { maximumBytes: number; contentLength: number; payloadHash: string; onError?: (error: unknown) => void }): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 0 || !Number.isSafeInteger(options.contentLength) || options.contentLength < 0) throw new StorageBodyError("IncompleteBody")
  if (options.contentLength > options.maximumBytes) throw new StorageBodyError("EntityTooLarge")
  if (options.payloadHash !== "UNSIGNED-PAYLOAD" && !/^[0-9a-f]{64}$/.test(options.payloadHash)) throw new StorageBodyError("XAmzContentSHA256Mismatch")
  const reader = source.getReader()
  const hash = options.payloadHash === "UNSIGNED-PAYLOAD" ? undefined : createHash("sha256")
  let bytes = 0
  let finished = false
  let pending: Uint8Array | undefined
  async function cancel(reason: unknown) {
    if (finished) return
    finished = true
    try { await reader.cancel(reason) } finally { reader.releaseLock() }
  }
  async function pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
      try {
        let result = await reader.read()
        while (!result.done && result.value.byteLength === 0) result = await reader.read()
        if (result.done) {
          if (bytes !== options.contentLength) throw new StorageBodyError("IncompleteBody")
          if (hash && !timingSafeEqual(hash.digest(), Buffer.from(options.payloadHash, "hex"))) throw new StorageBodyError("XAmzContentSHA256Mismatch")
          finished = true
          reader.releaseLock()
          if (pending) controller.enqueue(pending)
          pending = undefined
          controller.close()
          return
        }
        bytes += result.value.byteLength
        if (bytes > options.maximumBytes) throw new StorageBodyError("EntityTooLarge")
        if (bytes > options.contentLength) throw new StorageBodyError("IncompleteBody")
        hash?.update(result.value)
        // Never deliver the final bytes until EOF, length and SHA-256 have been
        // verified. Otherwise an upstream can commit on Content-Length before
        // the caller observes a late hash failure. Retain one chunk, not a body.
        if (pending) { const previous = pending; pending = result.value; controller.enqueue(previous) }
        else { pending = result.value; await pull(controller) }
      } catch (error) {
        options.onError?.(error)
        await cancel(error).catch(() => undefined)
        controller.error(error)
      }
  }
  return new ReadableStream<Uint8Array>({
    pull,
    cancel,
  }, { highWaterMark: 0 })
}

/** A lease is held until the body finishes, errors or is cancelled, not merely
 * until response headers are returned. Workspace admission must surround the
 * same lifetime; this limiter is a separate bounded transport resource budget.
 */
export class StorageStreamAdmission {
  private accepting = true
  private readonly counts = new Map<string, number>()
  private active = 0
  private readonly waiters = new Set<() => void>()

  constructor(private readonly maximum: number, private readonly perWorkspace: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(perWorkspace) || perWorkspace < 1 || perWorkspace > maximum) throw new Error("Invalid storage concurrency limits.")
  }

  admit(workspaceId: string) {
    if (!workspaceId || !this.accepting || this.active >= this.maximum || (this.counts.get(workspaceId) || 0) >= this.perWorkspace) throw new Error("Storage admission unavailable.")
    this.active++
    this.counts.set(workspaceId, (this.counts.get(workspaceId) || 0) + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.active--
      const remaining = this.counts.get(workspaceId)! - 1
      if (remaining) this.counts.set(workspaceId, remaining)
      else this.counts.delete(workspaceId)
      for (const waiter of this.waiters) waiter()
    }
    return {
      release,
      stream: (source: ReadableStream<Uint8Array>) => {
        const reader = source.getReader()
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          reader.releaseLock()
          release()
        }
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const result = await reader.read()
              if (result.done) { finish(); controller.close() }
              else controller.enqueue(result.value)
            } catch (error) { finish(); controller.error(error) }
          },
          async cancel(reason) { try { await reader.cancel(reason) } finally { finish() } },
        }, { highWaterMark: 0 })
      },
    }
  }

  /** Stop admitting synchronously, then drain already admitted bodies. */
  stop() {
    this.accepting = false
    return this.drain()
  }

  drain(workspaceId?: string): Promise<void> {
    const pending = () => workspaceId ? this.counts.has(workspaceId) : this.active > 0
    if (!pending()) return Promise.resolve()
    return new Promise(resolve => {
      const check = () => {
        if (!pending()) { this.waiters.delete(check); resolve() }
      }
      this.waiters.add(check)
    })
  }
}
