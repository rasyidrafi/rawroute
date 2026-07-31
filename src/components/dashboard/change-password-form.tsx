"use client"

import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Input } from "@/components/ui/input"

import { FormField, FormSubmitButton } from "@/components/dashboard/shared"

export function ChangePasswordForm({ onSave }: { onSave: (currentPassword: string, newPassword: string, confirmPassword: string) => Promise<boolean> }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const formData = new FormData(form)
    const currentPassword = String(formData.get("currentPassword") || "")
    const newPassword = String(formData.get("newPassword") || "")
    const confirmPassword = String(formData.get("confirmPassword") || "")
    if (newPassword !== confirmPassword) { toast.error("New passwords do not match."); return }
    setPending(true)
    try { if (await onSave(currentPassword, newPassword, confirmPassword)) form.reset() } finally { setPending(false) }
  }
  return <form className="grid gap-5" onSubmit={submit}><FormField label="Current password"><Input name="currentPassword" type="password" autoComplete="current-password" required /></FormField><FormField label="New password"><Input name="newPassword" type="password" minLength={10} autoComplete="new-password" required /></FormField><FormField label="Confirm new password"><Input name="confirmPassword" type="password" minLength={10} autoComplete="new-password" required /></FormField><div><FormSubmitButton pending={pending} idleLabel="Update password" pendingLabel="Updating password..." /></div></form>
}