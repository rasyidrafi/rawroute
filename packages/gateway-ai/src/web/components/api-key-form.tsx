import { useState, type FormEvent } from "react"

import { DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@rawroute/ui/dialog"
import { Input } from "@rawroute/ui/input"

import { FormSubmitButton } from "@rawroute/ui/resource-feedback"

export function ApiKeyForm({ onSave, name }: { onSave: (name: string, key?: string) => Promise<boolean>; name?: string }) {
  const rotating = name !== undefined
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    const formData = new FormData(event.currentTarget)
    const key = String(formData.get("key") || "").trim()
    try { await onSave(rotating ? name : String(formData.get("name") || "").trim(), key || undefined) } finally { setPending(false) }
  }
  return <form onSubmit={submit}>
    <DialogHeader>
      <DialogTitle>{rotating ? "Replace API key" : "Create API key"}</DialogTitle>
      <DialogDescription>{rotating
        ? `Replacing ${name} immediately disables its current token for new requests. Leave the replacement value blank to generate a secure random token.`
        : "Give this key a recognizable name. Leave the value blank to generate a secure key."}</DialogDescription>
    </DialogHeader>
    <div className="grid gap-4 py-5">
      {!rotating && <div className="grid gap-2"><label htmlFor="gateway-api-key-name" className="text-sm font-medium">Key Name</label><Input id="gateway-api-key-name" name="name" maxLength={80} placeholder="Production gateway" autoFocus required /></div>}
      <div className="grid gap-2"><label htmlFor={rotating ? "gateway-api-key-replacement" : "gateway-api-key-value"} className="text-sm font-medium">{rotating ? "Replacement Key Value" : "Key Value"}</label><Input id={rotating ? "gateway-api-key-replacement" : "gateway-api-key-value"} name="key" maxLength={256} placeholder={rotating ? "Optional custom replacement token" : "Optional custom secret"} autoFocus={rotating} /></div>
    </div>
    <DialogFooter><FormSubmitButton pending={pending} idleLabel={rotating ? "Replace key" : "Create key"} pendingLabel={rotating ? "Replacing key..." : "Creating key..."} /></DialogFooter>
  </form>
}
