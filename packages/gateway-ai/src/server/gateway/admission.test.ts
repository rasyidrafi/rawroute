import { afterEach, expect, test } from "bun:test"
import { activeGatewayExecutions, admitGatewayExecution, drainGatewayExecutions, resumeGatewayExecutions } from "./admission"

afterEach(resumeGatewayExecutions)

test("shutdown waits for admitted inference and rejects new executions", async () => {
  const release = admitGatewayExecution()
  let drained = false
  const draining = drainGatewayExecutions(1_000).then(() => { drained = true })
  expect(() => admitGatewayExecution()).toThrow("shutting down")
  await Bun.sleep(30)
  expect(drained).toBe(false)
  release()
  release()
  await draining
  expect(activeGatewayExecutions()).toBe(0)
})

test("a drain timeout keeps admitted work owned and can be resumed", async () => {
  const release = admitGatewayExecution()
  await expect(drainGatewayExecutions(5)).rejects.toThrow("still running")
  expect(activeGatewayExecutions()).toBe(1)
  release()
  resumeGatewayExecutions()
  const next = admitGatewayExecution()
  next()
})
