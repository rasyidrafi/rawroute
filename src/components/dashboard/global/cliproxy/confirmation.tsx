import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"

export function Confirmation({ title, description, pending, onConfirm, onClose }: { title: string | null; description: string; pending: boolean; onConfirm: () => void; onClose: () => void }) {
  return <AlertDialog open={Boolean(title)} onOpenChange={open => { if (!open && !pending) onClose() }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel><AlertDialogAction disabled={pending} onClick={onConfirm}>{pending ? "Working…" : "Confirm"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
}
