"use client"

import { useState, type FormEvent } from "react"

import { Checkbox } from "@/components/ui/checkbox"
import { DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { Provider, ProviderApiKey } from "@/lib/types"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"

export function ProviderApiKeyForm({ providers, apiKey, onSave }: { providers: Provider[]; apiKey: ProviderApiKey | null; onSave: (apiKey: Partial<ProviderApiKey> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  const [enabled, setEnabled] = useState(apiKey?.enabled !== false)
  const scopedProvider = providers.length === 1 ? providers[0] : undefined
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    const formData = new FormData(event.currentTarget)
    try {
      await onSave({
        originalId: apiKey?.id,
        providerId: String(formData.get("providerId")),
        name: String(formData.get("name")),
        key: apiKey && !formData.get("key") ? "__unchanged__" : String(formData.get("key") || ""),
        enabled,
        rpmLimit: Number(formData.get("rpmLimit")),
        maxConcurrency: Number(formData.get("maxConcurrency")),
        priority: Number(formData.get("priority")),
      })
    } finally { setPending(false) }
  }
  return <form onSubmit={submit}><DialogHeader><DialogTitle>{apiKey ? "Edit provider API key" : "Add provider API key"}</DialogTitle><DialogDescription>The credential value is never returned to the browser after saving.</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><FormField label="Provider">{scopedProvider ? <><Input value={scopedProvider.name} readOnly className="bg-muted" /><input type="hidden" name="providerId" value={scopedProvider.id} /></> : <Select name="providerId" defaultValue={apiKey?.providerId || providers[0]?.id} itemToStringLabel={(value) => providers.find((provider) => provider.id === value)?.name || String(value)}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent></Select>}</FormField><FormField label="Key name"><Input name="name" defaultValue={apiKey?.name} maxLength={80} placeholder="Production key A" required /></FormField><FormField label="API key"><Input name="key" type="password" autoComplete="off" placeholder={apiKey ? "Leave blank to keep the current key" : "Enter upstream API key"} required={!apiKey} /></FormField><div className="grid gap-4 sm:grid-cols-3"><FormField label="Requests / minute"><Input name="rpmLimit" type="number" min={1} step={1} defaultValue={apiKey?.rpmLimit || 60} required /></FormField><FormField label="Max concurrency"><Input name="maxConcurrency" type="number" min={1} step={1} defaultValue={apiKey?.maxConcurrency || 4} required /></FormField><FormField label="Priority"><Input name="priority" type="number" min={0} max={100} step={1} defaultValue={apiKey?.priority || 0} required /></FormField></div><p className="text-xs text-muted-foreground">Sticky sessions reuse this key. New sessions choose the key with the most remaining RPM and concurrency capacity.</p><label className="flex items-center gap-3 rounded-lg border p-3"><Checkbox checked={enabled} onCheckedChange={setEnabled} /><span className="text-sm font-medium">Enabled for routing</span></label></div><DialogFooter><FormSubmitButton pending={pending} idleLabel={apiKey ? "Update API key" : "Add API key"} pendingLabel={apiKey ? "Updating API key..." : "Adding API key..."} /></DialogFooter></form>
}
