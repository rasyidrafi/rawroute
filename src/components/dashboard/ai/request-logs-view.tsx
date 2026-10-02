import { ListChecksIcon } from "lucide-react"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function RequestLogsView() {
  return <DashboardPage spacing="normal">
    <Card>
      <CardHeader><CardTitle variant="icon"><ListChecksIcon aria-hidden="true" />Request Logs</CardTitle><CardDescription>Request history for the selected workspace.</CardDescription></CardHeader>
      <CardContent><p className="text-sm text-muted-foreground">Request logs are not available yet.</p></CardContent>
    </Card>
  </DashboardPage>
}
