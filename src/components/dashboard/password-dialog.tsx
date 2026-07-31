"use client"

import { useState, type FormEvent } from "react"

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"

export function PasswordDialog({ open, onSave }: { open: boolean; onSave: (password: string) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    const formData = new FormData(event.currentTarget)
    try { await onSave(String(formData.get("password") || "")) } finally { setPending(false) }
  }
  return <Dialog open={open}><DialogContent showCloseButton={false}><form onSubmit={submit}><DialogHeader><DialogTitle>Set a private admin password</DialogTitle><DialogDescription>You signed in with the default password. Change it before configuring the gateway.</DialogDescription></DialogHeader><div className="py-5"><FormField label="New password"><Input name="password" type="password" minLength={10} autoComplete="new-password" required /></FormField></div><DialogFooter><FormSubmitButton pending={pending} idleLabel="Change password" pendingLabel="Changing password..." /></DialogFooter></form></DialogContent></Dialog>
}

export { toast }