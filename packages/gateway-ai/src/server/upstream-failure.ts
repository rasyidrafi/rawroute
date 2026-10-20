/** Read a bounded JSON error without logging provider messages or request content. */
export async function upstreamFailure(response: Response) {
  const result: { errorCode?: string; retrySeconds?: number } = {}
  const reader = response.clone().body?.getReader()
  if (!reader) return result
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 250
  try {
    while (text.length < 8192) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), Math.max(1, deadline - Date.now()))
      })]).finally(() => clearTimeout(timer))
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    if (text.length >= 8192) return result
    const payload = JSON.parse(text)
    const error = payload?.error
    const code = error?.code || error?.type
    if (typeof code === "string" && /^[a-zA-Z0-9_:-]{1,80}$/.test(code)) result.errorCode = code
    const reset = Number(error?.resets_at)
    const seconds = Number(error?.resets_in_seconds ?? error?.retry_after ?? payload?.retry_after)
    const retry = Number.isFinite(reset) && reset > Date.now() / 1000 ? reset - Date.now() / 1000 : seconds
    if (Number.isFinite(retry) && retry > 0) result.retrySeconds = Math.ceil(retry)
  } catch {
    // An opaque or streaming error must not prevent fallback.
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  return result
}
