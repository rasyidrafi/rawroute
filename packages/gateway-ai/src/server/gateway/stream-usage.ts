import { extractUsageMetrics, mergeUsage, type UsageMetrics } from "../usage-metrics"
import type { ServiceTierProfile } from "../../contracts/service-tier"

function objectValue(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function isTerminalStreamEvent(eventName: string, parsed: Record<string, unknown> | undefined) {
  const normalizedEvent = eventName.trim().toLowerCase()
  if (["message_stop", "response.completed", "response.incomplete", "response.failed", "response.cancelled", "response.canceled", "response.done", "message.completed", "message.done", "done", "error"].includes(normalizedEvent)) return true
  const type = typeof parsed?.type === "string" ? parsed.type.trim().toLowerCase() : ""
  if (["response.completed", "response.incomplete", "response.failed", "response.cancelled", "response.canceled", "response.done", "message_stop", "message.completed", "message.done", "done", "error"].includes(type)) return true
  const response = objectValue(parsed?.response)
  return response?.status === "completed" || response?.status === "complete" || response?.status === "incomplete" || response?.status === "failed" || response?.status === "cancelled" || response?.status === "canceled"
}

export async function collectStreamUsage(body: ReadableStream<Uint8Array>, profile: ServiceTierProfile = "openai", chatChoiceCount?: number) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let usage: UsageMetrics | undefined
  let terminalEventSeen = false
  let failedEventSeen = false
  let readFailed = false
  let malformedDataSeen = false
  const finishedChoices = new Set<number>()
  let firstByteAt: number | undefined
  const readTimeoutMs = 300_000
  const deadline = Date.now() + readTimeoutMs
  const readWithTimeout = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const remaining = Math.max(0, deadline - Date.now())
    if (!remaining) throw new Error("Timed out while collecting streamed usage.")
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out while collecting streamed usage.")), remaining) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  let eventName = ""
  let dataLines: string[] = []
  const consumeEvent = () => {
    const payload = dataLines.join("\n").trim()
    dataLines = []
    const event = eventName
    eventName = ""
    if (!payload) return
    if (payload === "[DONE]") {
      terminalEventSeen = true
      return
    }
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      terminalEventSeen ||= isTerminalStreamEvent(event, parsed)
      if (chatChoiceCount !== undefined && Array.isArray(parsed.choices)) {
        parsed.choices.forEach((choice, position) => {
          const value = objectValue(choice)
          if (!value || value.finish_reason == null) return
          const rawIndex = value.index
          const index = rawIndex === undefined ? position : (typeof rawIndex === "number" && Number.isInteger(rawIndex) ? rawIndex : undefined)
          if (index !== undefined && index >= 0 && index < chatChoiceCount) finishedChoices.add(index)
        })
      }
      const type = typeof parsed.type === "string" ? parsed.type.trim().toLowerCase() : ""
      const response = objectValue(parsed.response)
      failedEventSeen ||= event.trim().toLowerCase() === "error" || ["error", "response.failed", "response.cancelled", "response.canceled"].includes(type) || ["failed", "cancelled", "canceled"].includes(String(response?.status))
      usage = mergeUsage(usage, extractUsageMetrics(parsed, profile))
    } catch {
      // A malformed data frame means the stream can no longer be trusted to
      // have ended cleanly; keep reading so explicit terminal markers and
      // usage still settle it.
      malformedDataSeen = true
    }
  }
  const consumeLine = (line: string) => {
    if (line.startsWith(":")) return
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim()
      return
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""))
      return
    }
    if (!line) consumeEvent()
  }
  const consumeBufferedLines = (final = false) => {
    let lines: string[]
    if (!final && buffer.endsWith("\r")) {
      lines = buffer.slice(0, -1).split(/\r\n|\r|\n/)
      buffer = `${lines.pop() || ""}\r`
    } else {
      lines = buffer.split(/\r\n|\r|\n/)
      buffer = final ? "" : lines.pop() || ""
    }
    for (const line of lines) consumeLine(line)
  }
  try {
    while (true) {
      const next = await readWithTimeout()
      if (next.done) {
        break
      }
      firstByteAt ??= Date.now()
      buffer += decoder.decode(next.value, { stream: true })
      consumeBufferedLines()
    }
  } catch {
    // Preserve any usage observed before an upstream disconnect/timeout. The
    // caller will settle the remaining amount conservatively when needed.
    readFailed = true
    await reader.cancel().catch(() => undefined)
  }
  buffer += decoder.decode()
  consumeBufferedLines(true)
  consumeEvent()
  // OpenAI-chat providers may close the stream without [DONE]; the response
  // completed only once every requested choice reported a finish_reason.
  const fallbackComplete = chatChoiceCount !== undefined && finishedChoices.size === chatChoiceCount
  return { usage, completedNormally: (terminalEventSeen || (fallbackComplete && !readFailed && !malformedDataSeen)) && !failedEventSeen, terminalEventSeen, firstByteAt }
}
