import { ArrowLeftIcon, LoaderCircleIcon, RefreshCwIcon, ShieldAlertIcon, WifiOffIcon } from "lucide-react"
import { Link } from "react-router"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { pagePaths } from "@/lib/dashboard/routes"

export function SessionBanner({ online, retrying, onRetry }: { online: boolean; retrying: boolean; onRetry: () => void }) {
  const Icon = online ? ShieldAlertIcon : WifiOffIcon

  return <aside aria-label="Session connection" className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-3xl pb-safe-bottom sm:inset-x-6 sm:bottom-6">
    <div className="shadow-lg">
      <Alert size="lg" aria-labelledby="session-banner-title" className="sm:has-[>svg]:grid-cols-[auto_1fr_auto]">
        <Icon aria-hidden="true" />
        <AlertTitle id="session-banner-title">{online ? "Unable to check your session" : "You’re offline"}</AlertTitle>
        <AlertDescription className="col-start-2">{online ? "We couldn’t reach your session. Check your connection and try again." : "Check your connection. We’ll retry when you’re back online."}</AlertDescription>
        <div className="col-span-full mt-3 flex flex-wrap gap-2 sm:col-span-1 sm:col-start-3 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:self-center">
          <Button className="flex-1 sm:flex-none" disabled={!online || retrying} aria-busy={retrying} onClick={onRetry}>
            {retrying ? <LoaderCircleIcon aria-hidden="true" data-icon="inline-start" className="animate-spin" /> : <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />}
            <span aria-live="polite">{!online ? "Waiting for connection" : retrying ? "Checking session…" : "Try again"}</span>
          </Button>
          <Link className={buttonVariants({ variant: "ghost", className: "flex-1 sm:flex-none" })} to={pagePaths.home}><ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />Back to home</Link>
        </div>
      </Alert>
    </div>
  </aside>
}
