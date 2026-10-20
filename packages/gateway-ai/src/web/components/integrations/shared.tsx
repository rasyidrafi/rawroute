import { useSyncExternalStore } from "react"
import { Link } from "react-router"
import { CopyIcon, KeyRoundIcon, WrenchIcon } from "lucide-react"
import { useDashboardClipboard } from "@rawroute/platform/web/use-dashboard-clipboard"
import { aiPagePaths as pagePaths } from "../../../contracts/pages"
import { Alert, AlertDescription, AlertTitle } from "@rawroute/ui/alert"
import { Button } from "@rawroute/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"

const subscribe = () => () => {}
const getBaseUrl = () => `${window.location.origin}/v1`
const getServerBaseUrl = () => "https://your-rawroute-host/v1"

export function useIntegrationBaseUrl() {
  return useSyncExternalStore(subscribe, getBaseUrl, getServerBaseUrl)
}

export function IntegrationCopyButton({ value, label, compact = false }: { value: string; label: string; compact?: boolean }) {
  const copy = useDashboardClipboard()
  return <Button variant="outline" size={compact ? "icon-sm" : "sm"} aria-label={label} onClick={() => void copy(value, `${label.replace(/^Copy /, "")} copied`)}>
    <CopyIcon data-icon="inline-start" />{!compact && "Copy"}
  </Button>
}

export function IntegrationKeyLink() {
  return <Button nativeButton={false} role="link" render={<Link to={pagePaths.endpoint} />}><KeyRoundIcon data-icon="inline-start" />Open Endpoint & Key</Button>
}

export function IntegrationPreviewNotice() {
  return <Alert role="note" size="lg">
    <WrenchIcon />
    <AlertTitle>Setup preview</AlertTitle>
    <AlertDescription>Explore example configurations. Keys and models are placeholders; no tools are connected or settings changed here.</AlertDescription>
  </Alert>
}

export function IntegrationSnippet({ title, filename, language, description, code }: { title: string; filename: string; language: string; description: string; code: string }) {
  return <Card>
    <CardHeader><CardTitle><h3>{title}</h3></CardTitle><CardDescription>{description}</CardDescription></CardHeader>
    <CardContent>
      <div className="overflow-hidden rounded-lg border bg-muted/30">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2"><span className="font-mono text-xs">{filename}</span><span className="text-xs text-muted-foreground">{language}</span></div>
          <IntegrationCopyButton value={code} label={`Copy ${filename}`} />
        </div>
        <pre tabIndex={0} aria-label={`${filename} example`} className="max-w-full overflow-x-auto p-4 text-xs leading-relaxed sm:text-sm"><code>{code}</code></pre>
      </div>
    </CardContent>
  </Card>
}

export function IntegrationBaseUrlCard({ baseUrl }: { baseUrl: string }) {
  return <Card size="sm">
    <CardHeader><CardDescription>Base URL</CardDescription><CardAction><IntegrationCopyButton compact value={baseUrl} label="Copy base URL" /></CardAction></CardHeader>
    <CardContent><code className="break-all text-sm">{baseUrl}</code></CardContent>
  </Card>
}
