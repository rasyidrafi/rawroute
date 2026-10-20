import { afterEach, expect, test } from "bun:test"
import { activeExecutions, admitExecution, drainExecutions, resumeExecutions } from "./admission"
import { withLifecycleMutation, withManagementMutation } from "./mutations"

afterEach(resumeExecutions)

test("maintenance waits for admitted work and rejects new admission without forcing running streams", async () => {
  const release = admitExecution()
  let drained = false
  const draining = drainExecutions(1000).then(() => { drained = true })
  expect(() => admitExecution()).toThrow("draining")
  await Bun.sleep(30)
  expect(drained).toBe(false)
  release(); release()
  await draining
  expect(activeExecutions()).toBe(0)
})

test("drain timeout keeps running work owned and allows recovery", async () => {
  const release = admitExecution()
  await expect(drainExecutions(5)).rejects.toThrow("left running")
  expect(activeExecutions()).toBe(1)
  release(); resumeExecutions()
  const next = admitExecution(); next()
})

test("global management serializes complete updates and lifecycle drains them first", async () => {
  process.env.CLIPROXY_MODE = "external"
  const seen: string[] = []
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const first = withManagementMutation(async () => { seen.push("read"); await barrier; seen.push("write") })
  const second = withManagementMutation(async () => { seen.push("next-read"); await withManagementMutation(async () => { seen.push("nested-write") }) })
  const lifecycle = withLifecycleMutation(async () => { seen.push("restart"); await withManagementMutation(async () => { seen.push("reconcile") }) })
  await expect(withLifecycleMutation(async () => undefined)).rejects.toThrow("in progress")
  await expect(withManagementMutation(async () => undefined)).rejects.toThrow("busy")
  release()
  await Promise.all([first, second, lifecycle])
  expect(seen).toEqual(["read", "write", "next-read", "nested-write", "restart", "reconcile"])
})
