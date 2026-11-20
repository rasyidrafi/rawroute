import { useSyncExternalStore } from "react"
import { Link } from "react-router"
import { CopyIcon, KeyRoundIcon } from "lucide-react"
import { useDashboardClipboard } from "@rawroute/platform/web/use-dashboard-clipboard"
import { aiPagePaths as pagePaths } from "../../../contracts/pages"
import { Button } from "@rawroute/ui/button"

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

export function IntegrationSnippet({ filename, language, code }: { filename: string; language: string; code: string }) {
  return <div className="overflow-hidden rounded-lg border bg-muted/30">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2"><span className="font-mono text-xs">{filename}</span><span className="text-xs text-muted-foreground">{language}</span></div>
          <IntegrationCopyButton value={code} label={`Copy ${filename}`} />
        </div>
        <pre tabIndex={0} aria-label={`${filename} example`} className="max-w-full overflow-x-auto p-4 text-xs leading-relaxed sm:text-sm"><code>{code}</code></pre>
      </div>
}
