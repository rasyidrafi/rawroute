import { LoginForm } from "../login-form"
import { AuthPageLayout } from "../auth-page-layout"

export function LoginPage({ checkingSession = false, sessionUnavailable = false }: { checkingSession?: boolean; sessionUnavailable?: boolean }) {
  return (
    <AuthPageLayout><LoginForm checkingSession={checkingSession} sessionUnavailable={sessionUnavailable} /></AuthPageLayout>
  )
}
