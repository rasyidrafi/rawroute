"use client"

import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { supportedProviderAuthTypes } from "@/lib/cliproxy-provider-capabilities"
import type { AuthType, Protocol, Provider } from "@/lib/types"
import { protocolLabels } from "@/lib/types"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"

const protocols: Protocol[] = ["openai-chat", "openai-responses", "anthropic-messages"]
const authLabels: Record<AuthType, string> = {
  bearer: "Bearer token",
  "x-api-key": "x-api-key",
  none: "None",
}

function initialAuthType(provider: Provider | null, protocol: Protocol, baseUrl: string): AuthType {
  const configured = provider?.authType || "bearer"
  return supportedProviderAuthTypes(protocol, baseUrl).includes(configured) ? configured : "bearer"
}

export function ProviderForm({ provider, onSave }: { provider: Provider | null; onSave: (provider: Partial<Provider> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  const [protocol, setProtocol] = useState<Protocol>(provider?.protocol || "openai-chat")
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || "")
  const [authType, setAuthType] = useState<AuthType>(() => initialAuthType(provider, protocol, baseUrl))
  const [supportPromptCacheKey, setSupportPromptCacheKey] = useState(provider?.supportPromptCacheKey === true)
  const authOptions = supportedProviderAuthTypes(protocol, baseUrl)

  function setProtocolAndAuth(nextProtocol: Protocol) {
    setProtocol(nextProtocol)
    if (nextProtocol === "anthropic-messages") setSupportPromptCacheKey(false)
    const nextOptions = supportedProviderAuthTypes(nextProtocol, baseUrl)
    setAuthType((current) => nextOptions.includes(current) ? current : nextOptions[0] || "bearer")
  }

  function setBaseUrlAndAuth(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl)
    const nextOptions = supportedProviderAuthTypes(protocol, nextBaseUrl)
    setAuthType((current) => nextOptions.includes(current) ? current : nextOptions[0] || "bearer")
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    const formData = new FormData(event.currentTarget)
    let headers: Record<string, string> = {}
    try {
      headers = JSON.parse(String(formData.get("headers") || "{}"))
    } catch {
      toast.error("Headers must be valid JSON")
      setPending(false)
      return
    }
    try {
      await onSave({
        originalId: provider?.id,
        name: String(formData.get("name")),
        prefix: String(formData.get("prefix")),
        baseUrl,
        protocol,
        authType,
        headers,
        supportPromptCacheKey,
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{provider ? "Edit provider" : "Add provider"}</DialogTitle>
        <DialogDescription>Configure the upstream origin first, then attach one or more API keys. RawRoute keeps the provider catalog and CLIProxy handles translation and forwarding.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        <FormField label="Name"><Input name="name" defaultValue={provider?.name} placeholder="OpenAI" required /></FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Prefix"><Input name="prefix" defaultValue={provider?.prefix} placeholder="oa" required /></FormField>
          <FormField label="Default protocol">
            <Select value={protocol} onValueChange={(value) => { if (value) setProtocolAndAuth(value as Protocol) }} itemToStringLabel={(value) => protocolLabels[value as Protocol] || String(value)}>
              <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{protocols.map((item) => <SelectItem key={item} value={item}>{protocolLabels[item]}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
        </div>
        <FormField label="Base URL"><Input name="baseUrl" value={baseUrl} onChange={(event) => setBaseUrlAndAuth(event.target.value)} type="url" placeholder={protocol === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1"} required /></FormField>
        <FormField label="Authentication">
          <Select value={authType} onValueChange={(value) => { if (value) setAuthType(value as AuthType) }} itemToStringLabel={(value) => authLabels[value as AuthType] || String(value)}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{authOptions.map((item) => <SelectItem key={item} value={item}>{authLabels[item]}</SelectItem>)}</SelectContent>
          </Select>
        </FormField>
        {protocol === "anthropic-messages" && authOptions.includes("x-api-key") ? <p className="-mt-2 text-xs text-muted-foreground">CLIProxy appends /v1/messages. You may enter the Anthropic URL with or without a trailing /v1; RawRoute stores the canonical base URL. x-api-key is available only for the first-party Anthropic endpoint.</p> : protocol !== "anthropic-messages" ? <p className="-mt-2 text-xs text-muted-foreground">CLIProxy sends provider credentials as Bearer tokens. Static headers below are forwarded separately.</p> : null}
        {protocol !== "anthropic-messages" && <div className="grid gap-2"><label className="flex items-start gap-3 rounded-lg border p-3"><Checkbox checked={supportPromptCacheKey} onCheckedChange={(checked) => setSupportPromptCacheKey(checked === true)} disabled={pending} /><span className="grid gap-1"><span className="text-sm font-medium">Enable CLIProxy prompt cache key support</span><span className="text-xs text-muted-foreground">Passes the native <code>support-prompt-cache-key</code> option to CLIProxy for this OpenAI-compatible provider.</span></span></label></div>}
        <FormField label="Static headers (JSON)"><Textarea name="headers" defaultValue={JSON.stringify(provider?.headers || {}, null, 2)} className="font-mono text-xs" /></FormField>
      </div>
      <DialogFooter><FormSubmitButton pending={pending} idleLabel={provider ? "Update provider" : "Save provider"} pendingLabel={provider ? "Updating provider..." : "Saving provider..."} /></DialogFooter>
    </form>
  )
}
