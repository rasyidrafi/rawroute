import { useState } from "react"
import { RotateCcwIcon } from "lucide-react"
import { toast } from "sonner"
import useSWR from "swr"

import { apiPatch, apiPost, fetcher } from "@/components/dashboard/api"
import { CodexResetCredits } from "@/components/dashboard/codex-reset-credits"
import { EmptyRow } from "@/components/dashboard/shared"
import { LoadingSpinner } from "@/components/loading-spinner"
import { Panel } from "@/components/dashboard/management-panel"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TableColumns, Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import type { CodexUsageResult } from "@/lib/codex/usage"

type LimitAccount = { id: string; name: string; email?: string; enabled: boolean; usage?: CodexUsageResult }

export function LimitsView() {
  const { data, mutate, isLoading, isValidating } = useSWR<{ accounts: LimitAccount[] }>("/api/admin/limits", fetcher)
  const [target, setTarget] = useState<LimitAccount>()
  const [confirmation, setConfirmation] = useState("")
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const isPending = (key: string) => pending.has(key)

  async function toggle(account: LimitAccount) {
    const pendingKey = `toggle-account:${account.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiPatch(`/api/admin/oauth-providers/${account.id}`, { enabled: !account.enabled })
      await mutate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update account")
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(pendingKey)
        return next
      })
    }
  }

  async function reset() {
    if (!target) return
    const pendingKey = `reset-account:${target.id}`
    setPending((current) => new Set(current).add(pendingKey))
    try {
      await apiPost(`/api/admin/oauth-providers/${target.id}/reset`, { confirmation })
      setTarget(undefined)
      setConfirmation("")
      await mutate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to redeem reset")
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(pendingKey)
        return next
      })
    }
  }

  return <Panel title="Codex limits" description="Quota state and banked reset redemption for Codex OAuth accounts." icon={<RotateCcwIcon />} refresh={() => void mutate()} loading={isLoading || isValidating}>
    <Table>
      <TableColumns columns={[{ id: "Account", label: "Account" }, { id: "5-hour", label: "5-hour" }, { id: "Weekly", label: "Weekly" }, { id: "State", label: "State" }, { id: "actions" }]} />
      <TableBody>
        {(data?.accounts || []).map((account) => {
          const pendingKey = `toggle-account:${account.id}`
          const actions = <TableCell className="text-right">
            <div className="flex justify-end gap-2">
              <Button aria-busy={isPending(pendingKey)} size="sm" variant="outline" disabled={isPending(pendingKey)} onClick={() => void toggle(account)}>
                {isPending(pendingKey) && <LoadingSpinner />}{account.enabled ? "Disable" : "Enable"}
              </Button>
              {(account.usage?.unusedResetCredits ?? 0) > 0 && <Button size="sm" variant="outline" onClick={() => setTarget(account)} disabled={isPending(pendingKey) || account.usage?.weekly?.remainingPercent !== 0}>
                <RotateCcwIcon />Redeem {account.usage?.unusedResetCredits}
              </Button>}
            </div>
          </TableCell>

          if (account.usage?.error) return <TableRow key={account.id} variant="error">
            <TableCell colSpan={4} density="comfortable" className="whitespace-normal">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-medium text-destructive">{account.name}</span>
                <span className="break-words text-sm text-destructive">{account.usage.reauthRequired ? "Authentication token expired. Reauthorize this Codex account." : account.usage.error}</span>
              </div>
            </TableCell>
            {actions}
          </TableRow>

          return <TableRow key={account.id}>
            <TableCell>
              <div className="font-medium">{account.name}</div>
              <div className="text-xs text-muted-foreground">{account.email || "OAuth account"}</div>
            </TableCell>
            <TableCell>{account.usage?.fiveHour ? `${Math.round(account.usage.fiveHour.remainingPercent)}% left` : "N/A"}</TableCell>
            <TableCell>{account.usage?.weekly ? `${Math.round(account.usage.weekly.remainingPercent)}% left` : "N/A"}</TableCell>
            <TableCell>
              <Badge variant={account.enabled ? "secondary" : "outline"}>{account.enabled ? "Enabled" : "Disabled"}</Badge>
              <div className="mt-1 text-xs text-muted-foreground"><CodexResetCredits usage={account.usage} /></div>
            </TableCell>
            {actions}
          </TableRow>
        })}
        {!data?.accounts.length && <EmptyRow label="No Codex accounts connected yet." colSpan={5} />}
      </TableBody>
    </Table>
    <AlertDialog open={Boolean(target)} onOpenChange={(open) => {
      if (!open && !isPending(`reset-account:${target?.id}`)) setTarget(undefined)
    }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Redeem Codex reset credit?</AlertDialogTitle>
          <AlertDialogDescription>This consumes one available reset credit and requires confirmation containing <code>use my codex reset</code>.</AlertDialogDescription>
        </AlertDialogHeader>
        <Input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="use my codex reset" />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending(`reset-account:${target?.id}`)}>Cancel</AlertDialogCancel>
          <AlertDialogAction aria-busy={isPending(`reset-account:${target?.id}`)} disabled={!confirmation.toLowerCase().includes("use my codex reset") || isPending(`reset-account:${target?.id}`)} onClick={() => void reset()}>
            {isPending(`reset-account:${target?.id}`) && <LoadingSpinner />}Redeem reset
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Panel>
}
