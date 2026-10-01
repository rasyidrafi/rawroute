// Presentation copied from rawroute-simple/cliproxy-page.tsx, adapted to RawRoute's API.
import { useState } from "react"
import { CheckIcon, CopyIcon, RefreshCwIcon, TerminalIcon, ServerIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CardTitle, CardDescription } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export function CliProxyHeader({ refreshing = false, refresh }: { refreshing?: boolean; refresh?: () => void }) {
  return (
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
              <TerminalIcon className="size-3.5" /> System service
            </div>
            <h2 className="text-2xl font-semibold tracking-tight">CLIProxyAPI</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Manage the shared OpenAI-compatible proxy and its releases. Clients connect
              through this dashboard origin using workspace gateway keys.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2"><Button
            variant="outline"
            disabled={refreshing}
            onClick={() => refresh?.()}
          >
            {refreshing ? <RefreshCwIcon className="animate-spin" data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            {refreshing ? "Checking…" : "Recheck status"}
          </Button></div>
        </div>
  )
}

export function ServiceDetailsSkeleton() {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true" aria-label="Loading CLIProxyAPI details">{[1, 2, 3, 4].map((item) => <div key={item} className="rounded-lg border bg-background/70 px-3 py-2.5"><Skeleton className="h-3 w-24" /><Skeleton className="mt-2 h-4 w-32" /></div>)}</div>;
}

export function Detail({
  label,
  value,
  mono = false,
  wrap = false,
  copyable = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="min-w-0 rounded-lg border bg-background/70 px-3 py-2.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 text-xs text-muted-foreground">{label}</p>
        {copyable && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={copied ? `${label} copied` : `Copy ${label}`}
            title={copied ? "Copied" : `Copy ${label}`}
            onClick={() => void copyValue()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        )}
      </div>
      <p className={`mt-1 text-sm font-medium ${wrap ? "break-all" : "truncate"} ${mono ? "font-mono" : ""}`} title={value}>{value}</p>
    </div>
  );
}

export function ServiceHeaderFrame({ title, controls }: { title: React.ReactNode; controls?: React.ReactNode }) {
  return <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
    <div className="flex items-start gap-3"><div className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-muted/60"><ServerIcon className="size-5" /></div><div>
      <CardTitle><span className="flex flex-wrap items-center gap-2">{title}</span></CardTitle>
      <CardDescription>Shared provider engine for all workspaces.</CardDescription>
    </div></div>{controls}
  </div>
}
