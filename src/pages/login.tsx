import { LoginForm } from "@/components/login-form"
import { AuthPageLayout } from "@/components/auth-page-layout"

export function LoginPage({ checkingSession = false, sessionUnavailable = false }: { checkingSession?: boolean; sessionUnavailable?: boolean }) {
  return (
    <AuthPageLayout><LoginForm checkingSession={checkingSession} sessionUnavailable={sessionUnavailable} /></AuthPageLayout>
  )
}
