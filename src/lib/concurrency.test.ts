import { expect, test } from "bun:test"

import { mapConcurrent } from "@/lib/concurrency"

test("bounds concurrency and preserves input order when work completes out of order", async () => {
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const started: number[] = []
  const result = mapConcurrent([1, 2, 3], 2, async (value) => {
    started.push(value)
    if (value === 1) await first.promise
    if (value === 2) await second.promise
    return value * 2
  })
  expect(started).toEqual([1, 2])
  second.resolve()
  await second.promise
  first.resolve()
  expect(await result).toEqual([2, 4, 6])
})

test("stops scheduling after failure and drains work before a caller can roll back", async () => {
  const pending = Promise.withResolvers<void>()
  const failure = new Error("write failed")
  const started: number[] = []
  const completed: number[] = []
  let settled = false
  const result = mapConcurrent([1, 2, 3], 2, async (value) => {
    started.push(value)
    if (value === 1) throw failure
    await pending.promise
    completed.push(value)
  }).catch((error) => { settled = true; return error })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(started).toEqual([1, 2])
  pending.resolve()
  expect(await result).toBe(failure)
  expect(completed).toEqual([2])
})

test("serial execution preserves dependent writes and stops at the first failure", async () => {
  const written: number[] = []
  await expect(mapConcurrent([1, 2, 3], 1, async (value) => {
    if (value === 2) throw new Error("conflict")
    written.push(value)
  })).rejects.toThrow("conflict")
  expect(written).toEqual([1])
})

test("handles empty inputs and rejects invalid concurrency", async () => {
  expect(await mapConcurrent([], 2, async () => 1)).toEqual([])
  await expect(mapConcurrent([1], 0, async (value) => value)).rejects.toThrow(RangeError)
})
