import { ArrowRightIcon, KeyRoundIcon, RouteIcon, WrenchIcon } from "lucide-react"
import { Link } from "react-router"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { integrations, type Integration } from "./integrations/catalog"
import { IntegrationCopyButton, IntegrationKeyLink, IntegrationPreviewNotice, useIntegrationBaseUrl } from "./integrations/shared"

const endpoints = [
  { name: "Chat Completions", path: "/chat/completions", description: "OpenAI-compatible clients", protocol: "OpenAI" },
  { name: "Responses", path: "/responses", description: "Codex and Responses clients", protocol: "OpenAI" },
  { name: "Messages", path: "/messages", description: "Anthropic-compatible clients", protocol: "Anthropic" },
]

export function IntegrationsView() {
  const baseUrl = useIntegrationBaseUrl()
  return <DashboardPage spacing="normal">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted-foreground"><WrenchIcon className="size-3.5" />Connect your tools</div>
        <div className="flex flex-wrap items-center gap-3"><h2 className="text-2xl font-semibold tracking-tight">Integrations</h2><Badge variant="secondary">Preview</Badge></div>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Your favorite tools. One gateway. Connect your coding workflow to RawRoute.</p>
      </div>
      <div className="shrink-0"><IntegrationKeyLink /></div>
    </div>
    <Card>
      <CardHeader><CardTitle variant="icon"><RouteIcon className="size-5" /><h3>Your gateway connection</h3></CardTitle><CardDescription>Use a workspace gateway key and the endpoint that matches your client and model.</CardDescription></CardHeader>
      <CardContent><div className="flex flex-col gap-5">
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
          <div className="min-w-0"><p className="mb-1 text-xs text-muted-foreground">Base URL</p><code className="break-all text-sm">{baseUrl}</code></div>
          <IntegrationCopyButton compact value={baseUrl} label="Copy base URL" />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {endpoints.map(endpoint => <div key={endpoint.path} className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-medium">{endpoint.name}</h4><Badge variant="outline">{endpoint.protocol}</Badge></div>
            <p className="text-xs text-muted-foreground">{endpoint.description}</p>
            <div className="flex min-w-0 items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs text-muted-foreground">{baseUrl}{endpoint.path}</code><IntegrationCopyButton compact value={`${baseUrl}${endpoint.path}`} label={`Copy ${endpoint.name} endpoint`} /></div>
          </div>)}
        </div>
      </div></CardContent>
      <CardFooter><div className="flex items-center gap-2"><KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" /><p className="text-xs text-muted-foreground">One workspace key across your tools. Available models follow your workspace routing.</p></div></CardFooter>
    </Card>
    <section aria-labelledby="integration-catalog-title" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2"><div><h3 id="integration-catalog-title" className="text-lg font-medium">Choose your tool</h3><p className="mt-1 text-sm text-muted-foreground">Start with a setup guide tailored to your workflow.</p></div><Badge variant="outline">2 guide previews · {integrations.length} tools</Badge></div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{integrations.map(integration => <IntegrationCard key={integration.name} integration={integration} />)}</div>
    </section>
    <IntegrationPreviewNotice />
  </DashboardPage>
}

function IntegrationCard({ integration }: { integration: Integration }) {
  const Icon = integration.icon
  return <Card className="h-full">
    <CardHeader><div className="mb-3 flex items-center justify-between gap-3"><div className="flex size-10 items-center justify-center rounded-lg border bg-muted/30"><Icon className="size-5" /></div><Badge variant={integration.href ? "secondary" : "outline"}>{integration.href ? "Guide preview" : "Coming soon"}</Badge></div><CardTitle><h4>{integration.name}</h4></CardTitle><CardDescription>{integration.category}</CardDescription></CardHeader>
    <CardContent className="flex-1"><p className="text-sm text-muted-foreground">{integration.description}</p></CardContent>
    <div className="px-4"><Separator /></div>
    <CardContent>{integration.href ? <Button className="w-full justify-between" variant="outline" nativeButton={false} role="link" render={<Link to={integration.href} />} aria-label={`View ${integration.name} setup guide`}>View setup guide<ArrowRightIcon data-icon="inline-end" /></Button> : <Button className="w-full" variant="outline" disabled>Guide coming soon</Button>}</CardContent>
  </Card>
}
