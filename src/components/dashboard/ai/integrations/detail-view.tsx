import { ArrowLeftIcon, ArrowRightIcon, KeyRoundIcon } from "lucide-react"
import { Link } from "react-router"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { pagePaths } from "@/lib/dashboard/routes"
import { integrationGuides, integrationSnippets, type IntegrationGuideId } from "./catalog"
import { IntegrationBaseUrlCard, IntegrationKeyLink, IntegrationPreviewNotice, IntegrationSnippet, useIntegrationBaseUrl } from "./shared"

export function IntegrationDetailView({ integration }: { integration: IntegrationGuideId }) {
  const guide = integrationGuides[integration]
  const Icon = guide.icon
  const baseUrl = useIntegrationBaseUrl()
  return <DashboardPage spacing="normal">
    <div><Button variant="ghost" nativeButton={false} role="link" render={<Link to={pagePaths.integrations} />}><ArrowLeftIcon data-icon="inline-start" />Back to integrations</Button></div>
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-lg border bg-muted/30"><Icon className="size-6" /></div>
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle variant="page"><h2>{guide.name}</h2></CardTitle>
            <CardDescription>{guide.description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 p-px lg:grid-cols-3">
          <IntegrationBaseUrlCard baseUrl={baseUrl} />
          <Card size="sm"><CardHeader><CardDescription>Configuration file</CardDescription></CardHeader><CardContent><code className="break-all text-sm">{guide.configPath}</code></CardContent></Card>
          <Card size="sm"><CardHeader><CardDescription>Connection</CardDescription></CardHeader><CardContent><div className="flex flex-col gap-2"><p className="text-sm">{guide.protocol} API</p><div className="flex items-center gap-2 text-xs text-muted-foreground"><KeyRoundIcon className="size-3.5" />Workspace gateway key</div></div></CardContent></Card>
        </div>
      </CardContent>
      <CardFooter><div className="flex w-full flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Start with a key from the workspace you want to connect.</p><IntegrationKeyLink /></div></CardFooter>
    </Card>
    <IntegrationPreviewNotice />
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <Card>
        <CardHeader><CardTitle><h3>Set up {guide.name}</h3></CardTitle><CardDescription>From gateway key to your first session.</CardDescription></CardHeader>
        <CardContent><ol className="flex flex-col gap-6">{guide.steps.map((step, index) => <li key={step.title} className="flex gap-3"><Badge variant="secondary">{index + 1}</Badge><div className="min-w-0"><h4 className="text-sm font-medium">{step.title}</h4><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.description}</p></div></li>)}</ol></CardContent>
        <CardFooter><Button variant="ghost" nativeButton={false} role="link" render={<Link to={pagePaths.aliases} />}>Open Model routing<ArrowRightIcon data-icon="inline-end" /></Button></CardFooter>
      </Card>
      <section aria-label="Configuration examples" className="flex min-w-0 flex-col gap-4">{integrationSnippets(integration, baseUrl).map(snippet => <IntegrationSnippet key={snippet.filename} {...snippet} />)}</section>
    </div>
  </DashboardPage>
}
