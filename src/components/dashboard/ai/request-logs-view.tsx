import { ListChecksIcon } from "lucide-react"
import { DashboardPage } from "@/components/dashboard/page-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"

export function RequestLogsView() {
  return <DashboardPage spacing="normal">
    <Card>
      <CardHeader><CardTitle variant="icon"><ListChecksIcon aria-hidden="true" />Request Logs</CardTitle><CardDescription>Request history for the selected workspace.</CardDescription></CardHeader>
      <CardContent><EmptyState title="Request logs are not available yet" description="Request history for the selected workspace is not shown on this page." icon={ListChecksIcon} treatment="embedded" /></CardContent>
    </Card>
  </DashboardPage>
}
