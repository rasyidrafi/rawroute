"use client"

import { useState, type FormEvent } from "react"

import { DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"

export function ApiKeyForm({ onSave }: { onSave: (name: string) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    const formData = new FormData(event.currentTarget)
    try { await onSave(String(formData.get("name") || "").trim()) } finally { setPending(false) }
  }
  return <form onSubmit={submit}><DialogHeader><DialogTitle>Create API key</DialogTitle><DialogDescription>Give this key a recognizable name for the client or environment that will use it.</DialogDescription></DialogHeader><div className="py-5"><FormField label="Key Name"><Input name="name" maxLength={80} placeholder="Production gateway" autoFocus required /></FormField></div><DialogFooter><FormSubmitButton pending={pending} idleLabel="Create key" pendingLabel="Creating key..." /></DialogFooter></form>
}