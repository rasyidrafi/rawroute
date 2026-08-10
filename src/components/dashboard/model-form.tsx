"use client"

import { useState, type FormEvent } from "react"

import { DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { Model, Provider } from "@/lib/types"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"

export function ModelForm({ provider, model, onSave }: { provider: Provider; model: Model | null; onSave: (model: Partial<Model> & { originalId?: string }) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  const gatewayId = model?.gatewayModelId || model?.id
  const gatewayFieldValue = gatewayId?.includes("/") ? gatewayId.slice(gatewayId.lastIndexOf("/") + 1) : gatewayId

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    const formData = new FormData(event.currentTarget)
    try {
      await onSave({
        originalId: model?.id,
        providerId: provider.id,
        gatewayModelId: `${provider.prefix}/${String(formData.get("gatewayModelId")).trim()}`,
        name: String(formData.get("name")),
        upstreamModel: String(formData.get("upstreamModel")),
      })
    } finally { setPending(false) }
  }

  return <form onSubmit={submit}><DialogHeader><DialogTitle>{model ? "Edit model" : "Add model"}</DialogTitle><DialogDescription>{`Set the gateway-facing model suffix for ${provider.name}. The provider protocol applies to every model in this provider.`}</DialogDescription></DialogHeader><div className="grid gap-4 py-4"><div className="grid gap-4 sm:grid-cols-2"><FormField label="Model Name"><Input name="name" defaultValue={model?.name} placeholder="Halotec Pro" required /></FormField><FormField label="Gateway Model ID"><div className="flex h-9 overflow-hidden rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30"><span className="flex shrink-0 items-center border-r bg-muted px-3 font-mono text-sm text-muted-foreground">{provider.prefix}/</span><Input name="gatewayModelId" defaultValue={gatewayFieldValue} placeholder="halotec-pro" className="h-full rounded-none border-0 bg-transparent font-mono shadow-none focus-visible:ring-0" required /></div></FormField></div><FormField label="Upstream Model ID"><Input name="upstreamModel" defaultValue={model?.upstreamModel} placeholder="gpt-5.3-codex" required /></FormField></div><DialogFooter><FormSubmitButton pending={pending} idleLabel={model ? "Update model" : "Add model"} pendingLabel={model ? "Updating model..." : "Saving model..."} /></DialogFooter></form>
}
