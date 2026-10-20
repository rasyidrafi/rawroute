import { afterEach, expect, test } from "bun:test"
import { closeLocalCache, localCacheGet, localCacheSet, localCacheSetIfAbsent, localCacheCompareAndDelete } from "../../packages/platform/src/server/local-cache"

afterEach(closeLocalCache)
test("cache expiry and coordination ownership", async () => {
  await localCacheSet("value", "cached", 1)
  await Bun.sleep(5)
  expect(await localCacheGet("value")).toBeNull()
  expect(await localCacheSetIfAbsent("lock", "owner", 60_000)).toBe(true)
  expect(await localCacheSetIfAbsent("lock", "other", 60_000)).toBe(false)
  expect(await localCacheCompareAndDelete("lock", "other")).toBe(false)
  expect(await localCacheCompareAndDelete("lock", "owner")).toBe(true)
})
test("cache pressure cannot evict a coordination lease", async () => {
  await localCacheSetIfAbsent("lock", "owner", 60_000)
  for (let index = 0; index < 5000; index++) await localCacheSet(`cache:${index}`, "value", 60_000)
  expect(await localCacheSetIfAbsent("lock", "other", 60_000)).toBe(false)
})

test("lease expiry permits a new owner without letting the old owner release it", async () => {
  await localCacheSetIfAbsent("lock", "first", 1)
  await Bun.sleep(5)
  expect(await localCacheSetIfAbsent("lock", "second", 60_000)).toBe(true)
  expect(await localCacheCompareAndDelete("lock", "first")).toBe(false)
  expect(await localCacheGet("lock")).toBe("second")
})

test("full coordination capacity rejects work instead of evicting owners", async () => {
  for (let index = 0; index < 4096; index++) await localCacheSetIfAbsent(`lock:${index}`, "owner", 60_000)
  await expect(localCacheSetIfAbsent("overflow", "other", 60_000)).rejects.toThrow("capacity exceeded")
  expect(await localCacheGet("lock:0")).toBe("owner")
})
