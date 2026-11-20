import { Link } from "react-router"
import { ArrowRightIcon, DatabaseIcon, HardDriveIcon, KeyRoundIcon, PlugIcon } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rawroute/ui/card"
import { storagePagePaths } from "../contracts/pages"

export function StorageGuideCards() {
  const shortcuts = [
    { href: storagePagePaths.storageConnections, label: "Connections", description: "Configure upstream services.", icon: PlugIcon },
    { href: storagePagePaths.storageBuckets, label: "Buckets", description: "Attach existing buckets.", icon: DatabaseIcon },
    { href: storagePagePaths.storageKeys, label: "Client keys", description: "Control client access.", icon: KeyRoundIcon },
  ]
  return <>
    <Card><CardHeader><CardTitle variant="icon"><HardDriveIcon className="size-5" />Connect an S3 client</CardTitle><CardDescription>Clients use the Storage S3 endpoint configured for this deployment, separate from the dashboard address.</CardDescription></CardHeader><CardContent className="flex flex-col" spacing="compact-flow"><p className="text-sm text-muted-foreground">Sign requests for region <code className="rounded bg-muted px-1 py-0.5">us-east-1</code>. Use path-style bucket addressing. Unsupported S3 features are rejected rather than silently ignored.</p><p className="text-sm text-muted-foreground">Start by adding a connection, attach an existing bucket, then issue a client key with only the access it needs.</p></CardContent></Card>
    <Card><CardHeader><CardTitle>Manage storage</CardTitle></CardHeader><CardContent spacing="compact-flow" className="grid sm:grid-cols-3">{shortcuts.map(item => <Link key={item.href} to={item.href} className="rounded-lg border bg-muted/20 p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><div className="flex items-center gap-2 font-medium"><item.icon className="size-4" />{item.label}<ArrowRightIcon className="ml-auto size-4" /></div><p className="mt-1 text-sm text-muted-foreground">{item.description}</p></Link>)}</CardContent></Card>
  </>
}
