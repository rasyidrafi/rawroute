import { ArrowLeftIcon } from "lucide-react"
import { Link } from "react-router"
import { DashboardPage } from "@rawroute/ui/page-layout"
import { Button } from "@rawroute/ui/button"
import { aiPagePaths as pagePaths } from "../../../contracts/pages"
import { integrationGuides, integrationSnippets, type IntegrationGuideId } from "./catalog"
import { IntegrationKeyLink, IntegrationSnippet, useIntegrationBaseUrl } from "./shared"

export function IntegrationDetailView({ integration }: { integration: IntegrationGuideId }) {
  const guide = integrationGuides[integration]
  const Icon = guide.icon
  const baseUrl = useIntegrationBaseUrl()
  const [config, terminal] = integrationSnippets(integration, baseUrl)
  return <DashboardPage spacing="normal" width="narrow">
    <div><Button variant="ghost" nativeButton={false} role="link" render={<Link to={pagePaths.integrations} />}><ArrowLeftIcon data-icon="inline-start" />Back to integrations</Button></div>
    <header className="flex items-center gap-3">
      <div className="flex size-12 shrink-0 items-center justify-center rounded-lg border bg-muted/30"><Icon className="size-6" /></div>
      <div><h2 className="text-2xl font-semibold tracking-tight">Set up {guide.name}</h2><p className="text-sm text-muted-foreground">{guide.description}</p></div>
    </header>
    <ol className="max-w-3xl list-decimal space-y-6 pl-6 marker:font-medium">
      <li><h3 className="font-medium">Get a workspace key</h3><div className="mt-2"><IntegrationKeyLink /></div></li>
      <li><h3 className="font-medium">Configure your provider</h3>
        <p className="my-2 text-sm text-muted-foreground">Merge this example into <code>{guide.configPath}</code>. {guide.configHint} <Link className="underline" to={pagePaths.aliases}>Open Model routing</Link></p>
        {config && <IntegrationSnippet {...config} />}
      </li>
      <li><h3 className="font-medium">Start {guide.name}</h3><p className="my-2 text-sm text-muted-foreground">{guide.launchHint}</p>{terminal && <IntegrationSnippet {...terminal} />}</li>
    </ol>
  </DashboardPage>
}
