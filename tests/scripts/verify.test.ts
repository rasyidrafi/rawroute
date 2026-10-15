import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runProcess, verify, type Check } from "../../scripts/verify"

test("verification overlaps only two branches and gates Chrome on lint and build", async () => {
  const started: Check[] = []
  let active = 0
  let peak = 0
  let finishUnits: (() => void) | undefined
  const units = new Promise<void>(resolve => { finishUnits = resolve })
  const results = await verify(async check => {
    started.push(check)
    active++
    peak = Math.max(peak, active)
    if (check === "test") await units
    if (check === "browser") {
      finishUnits?.()
      expect(started).toEqual(["test", "lint", "typecheck", "build", "browser"])
    }
    active--
    return 0
  }, 4)
  expect(peak).toBe(2)
  expect(results).toHaveLength(5)
  expect(results.every(result => result.status === "passed")).toBe(true)
})

test("one CPU runs sequentially and failures do not cancel independent checks", async () => {
  const started: Check[] = []
  const results = await verify(async check => {
    started.push(check)
    if (check === "lint") throw new Error("scanner failed")
    return check === "test" || check === "typecheck" ? 1 : 0
  }, 1)
  expect(started).toEqual(["test", "lint", "typecheck", "build", "browser"])
  expect(results.filter(result => result.status === "failed").map(result => result.check)).toEqual(["test", "lint", "typecheck"])
  expect(results.find(result => result.check === "browser")?.status).toBe("passed")
})

test("failed build blocks Chrome, but other checks finish", async () => {
  const results = await verify(async check => check === "build" ? 7 : 0, 2)
  expect(results.find(result => result.check === "browser")).toMatchObject({ status: "blocked", detail: "production build did not pass" })
  expect(results.filter(result => result.status === "passed")).toHaveLength(3)
})

test("interruption prevents pending checks from starting", async () => {
  const controller = new AbortController()
  const started: Check[] = []
  const results = await verify(async check => {
    started.push(check)
    controller.abort()
    return 143
  }, 2, controller.signal)
  expect(started).toEqual(["test"])
  expect(results.filter(result => result.status === "blocked")).toHaveLength(4)
})

test("subprocess runner preserves failure status and diagnostics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "verify-test-"))
  const log = join(directory, "failure.log")
  try {
    expect(await runProcess([process.execPath, "-e", 'console.error("intentional failure"); process.exit(7)'], log, new AbortController().signal)).toBe(7)
    expect(readFileSync(log, "utf8")).toContain("intentional failure")
    await expect(runProcess([join(directory, "missing-executable")], log, new AbortController().signal)).rejects.toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
