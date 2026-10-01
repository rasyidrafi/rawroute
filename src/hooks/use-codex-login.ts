import { useEffect, useState } from "react"
import { toast } from "sonner"

import { apiFetch, apiPost } from "@/components/dashboard/api"

type DeviceCode = { loginId: string; authorizationUrl: string }

export function useCodexLogin(onConnected: () => Promise<unknown>) {
  const [device, setDevice] = useState<DeviceCode | null>(null)
  const [accountName, setAccountName] = useState("")
  const [polling, setPolling] = useState(false)
  const [starting, setStarting] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState("")
  const [submittingCallback, setSubmittingCallback] = useState(false)

  useEffect(() => {
    if (!device || !polling) return
    const controller = new AbortController()
    let busy = false
    const timer = setInterval(async () => {
      if (busy || controller.signal.aborted) return
      busy = true
      try {
        const result = await apiFetch<{ status: "pending" | "authorized" }>("/api/admin/oauth-providers/codex/device/poll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ loginId: device.loginId, name: accountName.trim() || undefined }),
          signal: controller.signal,
        })
        if (controller.signal.aborted || result.status !== "authorized") return
        clearInterval(timer)
        setPolling(false)
        setDevice(null)
        setAccountName("")
        await onConnected()
        toast.success("Codex account connected")
      } catch (error) {
        if (!controller.signal.aborted) {
          clearInterval(timer)
          setPolling(false)
          toast.error(error instanceof Error ? error.message : "Codex login failed")
        }
      } finally {
        busy = false
      }
    }, 3000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [accountName, device, onConnected, polling])

  async function connect() {
    setStarting(true)
    try {
      setDevice(await apiPost<DeviceCode>("/api/admin/oauth-providers/codex/device/start", {}))
      setCallbackUrl("")
      setPolling(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to start Codex login")
    } finally {
      setStarting(false)
    }
  }

  function cancel() {
    if (device) void apiPost("/api/admin/oauth-providers/codex/device/cancel", { loginId: device.loginId }).catch(() => undefined)
    setPolling(false)
    setDevice(null)
    setCallbackUrl("")
  }

  async function submitCallback() {
    if (!device) return
    setSubmittingCallback(true)
    try {
      await apiPost("/api/admin/oauth-providers/codex/device/callback", { loginId: device.loginId, redirectUrl: callbackUrl })
      toast.success("Callback accepted. Finishing Codex login…")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to submit callback URL")
    } finally {
      setSubmittingCallback(false)
    }
  }

  return { device, accountName, setAccountName, polling, starting, callbackUrl, setCallbackUrl, submittingCallback, connect, cancel, submitCallback }
}
