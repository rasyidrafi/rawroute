import { expect, test } from "bun:test"
import "../../../packages/platform/src/server/timezone"
import { formatLog } from "../../../packages/observability/src/web/format"

test("copied and searchable logs format timestamps through the display timezone", () => {
  process.env.TIMEZONE = "America/New_York"
  expect(formatLog({
    id: "entry", timestamp: "2026-08-05T00:00:00.000Z", level: "info",
    source: "test", event: "test.event", message: "Ready", origin: "server",
    scope: "global", workspaceId: null, requestId: null, details: {},
  })).toBe("4 Aug 2026 20:00:00 INFO [test] Ready event=test.event origin=server scope=global")
})
