import { beforeEach, expect, test } from "vitest"

import { clearLogs, logVersion, readLogs, writeLog } from "@/lib/logger"

beforeEach(clearLogs)

test("stores newest sanitized log entries first", () => {
  writeLog("info", "gateway", "Request completed", { status: 200, model: "demo" })
  writeLog("warn", "admin", "Configuration rejected")
  expect(readLogs().map((entry) => entry.message)).toEqual(["Configuration rejected", "Request completed"])
})

test("bounds the in-memory log buffer", () => {
  for (let index = 0; index < 510; index++) writeLog("info", "system", `entry-${index}`)
  const logs = readLogs()
  expect(logs).toHaveLength(500)
  expect(logs[0]?.message).toBe("entry-509")
  expect(logs.at(-1)?.message).toBe("entry-10")
})

test("changes the lightweight log version without allocating unrelated entry IDs", () => {
  const before = logVersion()
  writeLog("info", "system", "versioned")
  const afterWrite = logVersion()
  expect(afterWrite).not.toBe(before)
  expect(readLogs()[0]?.id).toBe(afterWrite)
  clearLogs()
  expect(logVersion()).not.toBe(afterWrite)
})
