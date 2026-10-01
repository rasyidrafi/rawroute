import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadingCard, LoadingTable, LogLinesSkeleton } from "@/components/loading-layout"
import { DashboardPage } from "@/components/dashboard/page-layout"

export function ServiceDetailsSkeleton() {
  return <div className="space-y-4" aria-busy="true" aria-label="Loading CLIProxy status"><div className="flex gap-2"><Skeleton className="h-5 w-16" /><Skeleton className="h-5 w-36" /></div><div className="grid gap-3 text-sm sm:grid-cols-3">{["Installed version", "Selected release", "Active requests", "Recovery attempts"].map(label => <div key={label}><div className="text-muted-foreground">{label}</div><Skeleton className="h-5 w-20" /></div>)}</div><div className="flex flex-wrap gap-2">{["Start", "Restart", "Stop", "Refresh status"].map(label => <Button key={label} variant="outline" disabled>{label}</Button>)}</div></div>
}

export function CliProxySkeleton() {
  return <DashboardPage spacing="normal" aria-busy="true" aria-label="Loading CLIProxyAPI" data-slot="dashboard-content-skeleton">
    <LoadingCard title="CLIProxyAPI" description="Shared provider engine for all workspaces. Gateway settings · System Logs"><ServiceDetailsSkeleton /></LoadingCard>
    <LoadingCard title="Releases" description="Install a release or pin an exact version. Running requests finish before service changes."><div className="flex flex-wrap gap-2"><Skeleton className="h-8 w-44" /><Skeleton className="h-8 w-36" /></div><Field><FieldLabel>Exact release</FieldLabel><div className="flex flex-wrap gap-2"><Skeleton className="h-8 w-36" /><Button disabled variant="outline">Install selected version</Button></div></Field></LoadingCard>
    <LoadingCard title="Connection" description="Use a workspace gateway key with the public URL below."><div><Skeleton className="h-5 w-64 max-w-full" /><Skeleton className="h-8 w-36" /></div></LoadingCard>
    <LoadingCard title="CLIProxy API keys" description="Internal service keys. The RawRoute transport key is protected; public clients use workspace gateway keys."><Field><FieldLabel>New CLIProxy key</FieldLabel><div className="flex flex-wrap gap-2"><Skeleton className="h-8 w-full" /><Button disabled>Add key</Button></div></Field><LoadingTable columns={["Key", "Role", "Actions"]} rows={1} /></LoadingCard>
    <LoadingCard title="Global OAuth" description="Connect global engine accounts. Use workspace Codex Providers to connect accounts for workspace routing."><div className="flex flex-wrap gap-2">{["anthropic", "codex", "antigravity", "kimi", "xAI"].map(provider => <Button key={provider} variant="outline" disabled>Connect {provider}</Button>)}</div></LoadingCard>
    <LoadingCard title="Authentication files" description="Workspace-owned accounts are shown for visibility. Manage them from their workspace’s Codex Providers page."><Skeleton className="h-8 w-36" /><LoadingTable columns={["File", "Provider", "Owner", "Status", "Enabled", "Actions"]} /></LoadingCard>
    <LoadingCard title="CLIProxy logs" description="Engine logs across all workspaces, with secret redaction. Lifecycle events appear in System Logs."><div className="flex flex-wrap gap-2">{["Pause engine logs", "Refresh engine logs", "Copy engine logs", "Clear engine logs"].map(label => <Button key={label} variant="outline" disabled>{label}</Button>)}</div><Skeleton className="h-8 w-full" /><div className="h-72"><LogLinesSkeleton /></div></LoadingCard>
  </DashboardPage>
}
