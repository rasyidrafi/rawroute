import { useState, type FormEvent } from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { FormSubmitButton } from "@/components/dashboard/shared"

function PasswordField({ name, label, disabled, loading, hint }: { name: string; label: string; disabled: boolean; loading: boolean; hint?: string }) {
  const [visible, setVisible] = useState(false)
  const id = `admin-${name}`
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><div className="relative">{loading ? <Skeleton className="h-8 w-full" /> : <Input id={id} name={name} type={visible ? "text" : "password"} minLength={name === "currentPassword" ? undefined : 10} autoComplete={name === "currentPassword" ? "current-password" : "new-password"} required disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined} inset="trailing-icon" />}<Button type="button" variant="ghost" size="icon-sm" className="absolute right-0.5 top-0.5" disabled={disabled} aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`} aria-pressed={visible} onClick={() => setVisible(current => !current)}>{visible ? <EyeOffIcon /> : <EyeIcon />}</Button></div>{hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}</Field>
}

export function ChangePasswordForm({ onSave, loading = false }: { onSave: (currentPassword: string, newPassword: string, confirmPassword: string) => Promise<boolean>; loading?: boolean }) {
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (loading || pending) return
    const form = event.currentTarget
    const formData = new FormData(form)
    const currentPassword = String(formData.get("currentPassword") || "")
    const newPassword = String(formData.get("newPassword") || "")
    const confirmPassword = String(formData.get("confirmPassword") || "")
    if (newPassword !== confirmPassword) { toast.error("New passwords do not match."); return }
    setPending(true)
    try { if (await onSave(currentPassword, newPassword, confirmPassword)) form.reset() } finally { setPending(false) }
  }
  return <form className="grid gap-5" aria-busy={loading || pending} onSubmit={submit}>
    <PasswordField name="currentPassword" label="Current password" disabled={loading || pending} loading={loading} />
    <PasswordField name="newPassword" label="New password" disabled={loading || pending} loading={loading} hint="Use at least 10 characters and a different password from your current one." />
    <PasswordField name="confirmPassword" label="Confirm new password" disabled={loading || pending} loading={loading} />
    <div className="border-t pt-4"><FormSubmitButton pending={pending} disabled={loading} idleLabel="Update password" pendingLabel="Updating password..." /></div>
  </form>
}
