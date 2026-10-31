import { useState, type FormEvent } from "react"

import { Checkbox } from "@rawroute/ui/checkbox"
import { DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@rawroute/ui/dialog"
import { Input } from "@rawroute/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@rawroute/ui/select"
import type { Provider, ProviderApiKey, ProviderApiKeyInput } from "../../contracts/domain"

import { FormField, FormSubmitButton } from "@rawroute/ui/resource-feedback"

function optionalLimit(formData: FormData, name: string) {
  const value = String(formData.get(name) ?? "").trim()
  return value ? Number(value) : null
}

export function ProviderApiKeyForm({ providers, apiKey, onSave }: { providers: Provider[]; apiKey: ProviderApiKey | null; onSave: (apiKey: ProviderApiKeyInput) => Promise<boolean> }) {
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
        rpmLimit: optionalLimit(formData, "rpmLimit"),
        maxConcurrency: optionalLimit(formData, "maxConcurrency"),
      })
    } finally { setPending(false) }
  }
  return <form onSubmit={submit}>
    <DialogHeader>
      <DialogTitle>{apiKey ? "Edit provider API key" : "Add provider API key"}</DialogTitle>
      <DialogDescription>The credential value is never returned to the browser after saving.</DialogDescription>
    </DialogHeader>
    <div className="grid gap-4 py-4">
      <FormField label="Provider">
        {scopedProvider ? <><Input value={scopedProvider.name} readOnly variant="muted" /><input type="hidden" name="providerId" value={scopedProvider.id} /></> : <Select name="providerId" defaultValue={apiKey?.providerId || providers[0]?.id} itemToStringLabel={(value) => providers.find((provider) => provider.id === value)?.name || String(value)}><SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger><SelectContent>{providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent></Select>}
      </FormField>
      <FormField label="Key name"><Input name="name" defaultValue={apiKey?.name} maxLength={80} placeholder="Production key A" required /></FormField>
      <FormField label="API key"><Input name="key" type="password" autoComplete="off" placeholder={apiKey ? "Leave blank to keep the current key" : "Enter upstream API key"} required={!apiKey} /></FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Requests / minute (local limit)"><Input name="rpmLimit" type="number" min={1} step={1} defaultValue={apiKey?.rpmLimit ?? ""} /></FormField>
        <FormField label="Concurrency (local limit)"><Input name="maxConcurrency" type="number" min={1} step={1} defaultValue={apiKey?.maxConcurrency ?? ""} /></FormField>
      </div>
      <p className="text-xs text-muted-foreground">Leave blank for no local limit. Limits and session affinity are local to this RawRoute process; RPM counts and session routing reset on restart. Sessions reuse an available key; otherwise routing favors current load, with key order breaking ties. These limits do not change your provider quota.</p>
      <label className="flex items-center gap-3 rounded-lg border p-3"><Checkbox checked={enabled} onCheckedChange={setEnabled} /><span className="text-sm font-medium">Enabled for routing</span></label>
    </div>
    <DialogFooter><FormSubmitButton pending={pending} idleLabel={apiKey ? "Update API key" : "Add API key"} pendingLabel={apiKey ? "Updating API key..." : "Saving API key..."} /></DialogFooter>
  </form>
}
