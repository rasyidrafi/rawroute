import { afterEach, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"

process.env.REDIS_COMMAND_TIMEOUT_MS = "50"
const clients: RedisDouble[] = []
class RedisDouble extends EventEmitter {
  status = "connecting"
  set = mock(async () => {
    if (this.status !== "ready") throw new Error("Stream is not writable")
    return "OK"
  })
  quit = async () => "OK"
  constructor() { super(); clients.push(this) }
  ready() { this.status = "ready"; this.emit("ready") }
}
mock.module("ioredis", () => ({ default: RedisDouble }))
const { closeLocalRedis, localRedisSetIfAbsent } = await import("./local-redis")
afterEach(async () => { await closeLocalRedis(); clients.length = 0 })

test("the first OAuth reservation waits for Redis readiness within its deadline", async () => {
  const reservation = localRedisSetIfAbsent("login-lock", "login-id", 300_000)
  const client = clients.at(-1)!
  expect(client.set).not.toHaveBeenCalled()
  client.ready()
  expect(await reservation).toBe(true)
  expect(client.set).toHaveBeenCalledTimes(1)
  expect(client.set).toHaveBeenCalledWith("login-lock", "login-id", "PX", 300_000, "NX")
  expect(client.listenerCount("ready")).toBe(0)
  expect(client.listenerCount("end")).toBe(0)
})

test("a reservation that expires before readiness never acquires a late lock", async () => {
  expect(await localRedisSetIfAbsent("login-lock", "login-id", 300_000)).toBeUndefined()
  const client = clients.at(-1)!
  client.ready()
  expect(client.set).not.toHaveBeenCalled()
  expect(client.listenerCount("ready")).toBe(0)
  expect(client.listenerCount("end")).toBe(0)
})

test("connection closure releases a pending reservation without sending it", async () => {
  const reservation = localRedisSetIfAbsent("login-lock", "login-id", 300_000)
  const client = clients.at(-1)!
  client.status = "end"
  client.emit("end")
  expect(await reservation).toBeUndefined()
  expect(client.set).not.toHaveBeenCalled()
  expect(client.listenerCount("ready")).toBe(0)
})

test("a command failure remains an unavailable reservation", async () => {
  const reservation = localRedisSetIfAbsent("login-lock", "login-id", 300_000)
  const client = clients.at(-1)!
  client.set.mockRejectedValueOnce(new Error("Redis unavailable"))
  client.ready()
  expect(await reservation).toBeUndefined()
  expect(client.listenerCount("end")).toBe(0)
})

test("a command that stalls after readiness remains bounded", async () => {
  const reservation = localRedisSetIfAbsent("login-lock", "login-id", 300_000)
  const client = clients.at(-1)!
  client.set.mockImplementationOnce(() => new Promise<string>(() => undefined))
  client.ready()
  expect(await reservation).toBeUndefined()
  expect(client.set).toHaveBeenCalledTimes(1)
  expect(client.listenerCount("ready")).toBe(0)
  expect(client.listenerCount("end")).toBe(0)
})
