"use client"

import { useState, type ReactNode } from "react"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { LoadingSpinner } from "@/components/loading-spinner"
import { TableCell, TableRow } from "@/components/ui/table"

export function FormSubmitButton({ pending, idleLabel, pendingLabel }: { pending: boolean; idleLabel: string; pendingLabel: string }) {
  return <Button aria-busy={pending} disabled={pending} type="submit">{pending && <LoadingSpinner />}{pending ? pendingLabel : idleLabel}</Button>
}

export function FormField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-2"><Label>{label}</Label>{children}</div>
}

export function DetailValue({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-lg border bg-muted/20 p-4"><div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div><div className={`mt-2 text-sm font-medium ${mono ? "font-mono" : ""}`}>{value}</div></div>
}

export function EmptyRow({ label, colSpan = 5 }: { label: string; colSpan?: number }) {
  return <TableRow><TableCell colSpan={colSpan} className="h-28 text-center text-muted-foreground">{label}</TableCell></TableRow>
}

export function maskApiKey(key: string) {
  if (key.length <= 12) return `${key.slice(0, 4)}${"•".repeat(Math.max(4, key.length - 4))}`
  return `${key.slice(0, 7)}${"•".repeat(20)}${key.slice(-4)}`
}

export function ConfirmAction({ title, description, buttonLabel, pending, disabled, onConfirm, children }: { title: string; description: string; buttonLabel?: string; pending: boolean; disabled?: boolean; onConfirm: () => Promise<boolean>; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <AlertDialog open={open} onOpenChange={setOpen}><Button aria-label={title} disabled={disabled || pending} size={buttonLabel ? "sm" : "icon-sm"} variant="destructive" onClick={() => setOpen(true)}>{pending ? <LoadingSpinner /> : children}{buttonLabel}</Button><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={pending} onClick={async () => { if (await onConfirm()) setOpen(false) }}>{pending && <LoadingSpinner />}{buttonLabel || "Delete"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
}

export function EndpointValue() {
  const endpoint = typeof window === "undefined" ? "/v1" : `${window.location.origin}/v1`
  return <><code id="gateway-endpoint" suppressHydrationWarning className="min-w-0 flex-1 truncate text-sm">{endpoint}</code><script type={typeof window === "undefined" ? "text/javascript" : "text/plain"} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: '{var n=document.getElementById("gateway-endpoint");if(n)n.textContent=window.location.origin+"/v1"}' }} /></>
}

export function NotFoundState({ label = "Provider not found", description = "This resource may have been deleted or renamed.", backHref = "/dashboard/providers", backLabel = "Back to list" }: { label?: string; description?: string; backHref?: string; backLabel?: string; onBack?: () => void }) {
  return <main className="flex-1 bg-[#f6f5f1] p-4 dark:bg-background md:p-6 lg:p-8">
    <div className="mx-auto flex max-w-7xl flex-col gap-8">
      <Card>
        <CardHeader>
          <CardTitle>{label}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button nativeButton={false} variant="outline" render={<Link href={backHref} prefetch={false} />}><ArrowLeftIcon />{backLabel}</Button>
        </CardContent>
      </Card>
    </div>
  </main>
}
