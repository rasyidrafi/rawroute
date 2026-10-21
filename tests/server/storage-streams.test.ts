import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { StorageStreamAdmission, storageUploadBody } from "../../packages/gateway-storage/src/server/streams"

const encode = (value: string) => new TextEncoder().encode(value)
const source = (value: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encode(value)); controller.close() } })
const text = (value: ReadableStream<Uint8Array>) => new Response(value).text()

test("upload body verifies length/hash and rejects chunked overrun without buffering", async () => {
  const hash = createHash("sha256").update("hello").digest("hex")
  expect(await text(storageUploadBody(source("hello"), { maximumBytes: 5, contentLength: 5, payloadHash: hash }))).toBe("hello")
  expect(await text(storageUploadBody(source("hello"), { maximumBytes: 5, contentLength: 5, payloadHash: "UNSIGNED-PAYLOAD" }))).toBe("hello")
  await expect(text(storageUploadBody(source("hello"), { maximumBytes: 5, contentLength: 5, payloadHash: "0".repeat(64) }))).rejects.toThrow("XAmzContentSHA256Mismatch")
  await expect(text(storageUploadBody(source("hell"), { maximumBytes: 5, contentLength: 5, payloadHash: hash }))).rejects.toThrow("IncompleteBody")
  await expect(text(storageUploadBody(source("hello!"), { maximumBytes: 5, contentLength: 5, payloadHash: hash }))).rejects.toThrow("EntityTooLarge")
  expect(() => storageUploadBody(source("hello"), { maximumBytes: 4, contentLength: 5, payloadHash: hash })).toThrow("EntityTooLarge")
})

test("stream upload cancellation propagates to source and does not read ahead", async () => {
  let pulls = 0
  let cancelled = false
  const input = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(encode("x")) }, cancel() { cancelled = true } }, { highWaterMark: 0 })
  const output = storageUploadBody(input, { maximumBytes: 100, contentLength: 100, payloadHash: "UNSIGNED-PAYLOAD" })
  await Bun.sleep(1)
  expect(pulls).toBe(0)
  const reader = output.getReader()
  expect((await reader.read()).value).toEqual(encode("x"))
  expect(pulls).toBe(2)
  await reader.cancel()
  expect(cancelled).toBe(true)
})

test("final body bytes are withheld until SHA256 verification, including trailing empty chunks", async () => {
  const input = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encode("tampered")); controller.enqueue(new Uint8Array()); controller.close() } })
  const output = storageUploadBody(input, { maximumBytes: 8, contentLength: 8, payloadHash: createHash("sha256").update("original").digest("hex") })
  const reader = output.getReader()
  await expect(reader.read()).rejects.toThrow("XAmzContentSHA256Mismatch")
})

test("transport admission holds until stream consumption/cancel and drains workspaces independently", async () => {
  const admission = new StorageStreamAdmission(3, 2)
  const one = admission.admit("a")
  const two = admission.admit("a")
  const three = admission.admit("b")
  expect(() => admission.admit("a")).toThrow("unavailable")
  const output = one.stream(source("hello"))
  let drainedA = false
  let drainedAll = false
  const drainingA = admission.drain("a").then(() => { drainedA = true })
  const drainingAll = admission.stop().then(() => { drainedAll = true })
  expect(() => admission.admit("c")).toThrow("unavailable")
  await Bun.sleep(1)
  expect(drainedA).toBe(false)
  expect(await text(output)).toBe("hello")
  two.release()
  two.release()
  await drainingA
  expect(drainedAll).toBe(false)
  three.release()
  await drainingAll
  expect(drainedAll).toBe(true)
})

test("transport lease releases on cancellation and source error", async () => {
  const admission = new StorageStreamAdmission(1, 1)
  let cancelled = false
  const lease = admission.admit("a")
  const output = lease.stream(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }))
  await output.cancel()
  expect(cancelled).toBe(true)
  const failing = admission.admit("b").stream(new ReadableStream<Uint8Array>({ pull() { throw new Error("source failed") } }))
  await expect(text(failing)).rejects.toThrow("source failed")
  await admission.stop()
})

test("large generated upload is consumed incrementally with a bounded working set", async () => {
  const size = 64 * 1024 * 1024
  let generated = 0
  let consumed = 0
  let maximumAhead = 0
  const input = new ReadableStream<Uint8Array>({ pull(controller) {
    if (generated === size) { controller.close(); return }
    generated += 64 * 1024
    maximumAhead = Math.max(maximumAhead, generated - consumed)
    controller.enqueue(new Uint8Array(64 * 1024))
  } }, { highWaterMark: 0 })
  const output = storageUploadBody(input, { maximumBytes: size, contentLength: size, payloadHash: "UNSIGNED-PAYLOAD" })
  const reader = output.getReader()
  while (true) {
    const result = await reader.read()
    if (result.done) break
    consumed += result.value.byteLength
  }
  expect(consumed).toBe(size)
  expect(maximumAhead).toBe(128 * 1024)
})
