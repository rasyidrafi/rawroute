"use client"

import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { Protocol, Provider } from "@/lib/types"
import { protocolLabels } from "@/lib/types"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"

const protocols: Protocol[] = ["openai-chat", "openai-responses", "anthropic-messages"]

export function ProviderForm({ provider, onSave }: { provider: Provider | null; onSave: (provider: Partial<Provider> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    const formData = new FormData(event.currentTarget)
    let headers: Record<string, string> = {}
    try { headers = JSON.parse(String(formData.get("headers") || "{}")) } catch { toast.error("Headers must be valid JSON"); setPending(false); return }
    try {
      await onSave({
        originalId: provider?.id,
        name: String(formData.get("name")),
        prefix: String(formData.get("prefix")),
        baseUrl: String(formData.get("baseUrl")),
        protocol: String(formData.get("protocol")) as Protocol,
        authType: String(formData.get("authType")) as Provider["authType"],
        authHeader: String(formData.get("authHeader") || ""),
        headers,
      })
    } finally { setPending(false) }
  }
  return <form onSubmit={submit}><DialogHeader><DialogTitle>{provider ? "Edit provider" : "Add provider"}</DialogTitle><DialogDescription>Configure the upstream origin first, then attach one or more API keys.</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><FormField label="Name"><Input name="name" defaultValue={provider?.name} placeholder="OpenAI" required /></FormField><div className="grid gap-4 sm:grid-cols-2"><FormField label="Prefix"><Input name="prefix" defaultValue={provider?.prefix} placeholder="oa" required /></FormField><FormField label="Default protocol"><Select name="protocol" defaultValue={provider?.protocol || "openai-chat"} itemToStringLabel={(value) => protocolLabels[value as Protocol] || String(value)}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{protocols.map((item) => <SelectItem key={item} value={item}>{protocolLabels[item]}</SelectItem>)}</SelectContent></Select></FormField></div><FormField label="Base URL"><Input name="baseUrl" defaultValue={provider?.baseUrl} type="url" placeholder="https://api.openai.com/v1" required /></FormField><div className="grid gap-4 sm:grid-cols-2"><FormField label="Authentication"><Select name="authType" defaultValue={provider?.authType || "bearer"} itemToStringLabel={(value) => ({ bearer: "Bearer token", "x-api-key": "x-api-key", "custom-header": "Custom header", none: "None" }[value as Provider["authType"]] || String(value))}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bearer">Bearer token</SelectItem><SelectItem value="x-api-key">x-api-key</SelectItem><SelectItem value="custom-header">Custom header</SelectItem><SelectItem value="none">None</SelectItem></SelectContent></Select></FormField><FormField label="Custom auth header"><Input name="authHeader" defaultValue={provider?.authHeader} placeholder="X-Provider-Key" /></FormField></div><FormField label="Static headers (JSON)"><Textarea name="headers" defaultValue={JSON.stringify(provider?.headers || {}, null, 2)} className="font-mono text-xs" /></FormField></div><DialogFooter><FormSubmitButton pending={pending} idleLabel={provider ? "Update provider" : "Save provider"} pendingLabel={provider ? "Updating provider..." : "Saving provider..."} /></DialogFooter></form>
}
