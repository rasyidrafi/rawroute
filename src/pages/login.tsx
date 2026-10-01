import { LoginForm } from "@/components/login-form"

export function LoginPage({ checkingSession = false }: { checkingSession?: boolean }) {
  return (
    <div className="relative flex min-h-svh w-full items-center justify-center overflow-hidden bg-login-surface p-6 dark:bg-console md:p-10">
      <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(to_right,#94a3b822_1px,transparent_1px),linear-gradient(to_bottom,#94a3b822_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className="pointer-events-none absolute -left-32 top-12 size-96 rounded-full bg-warning-glow/30 blur-3xl" />
      <div className="relative w-full max-w-sm">
        <LoginForm checkingSession={checkingSession} />
      </div>
    </div>
  )
}
