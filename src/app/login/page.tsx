import { LoginForm } from "@/components/login-form"

export default function Page() {
  return (
    <div className="relative flex min-h-svh w-full items-center justify-center overflow-hidden bg-[#f3f0e8] p-6 dark:bg-slate-950 md:p-10">
      <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(to_right,#94a3b822_1px,transparent_1px),linear-gradient(to_bottom,#94a3b822_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className="pointer-events-none absolute -left-32 top-12 size-96 rounded-full bg-amber-300/30 blur-3xl" />
      <div className="relative w-full max-w-sm">
        <LoginForm />
      </div>
    </div>
  )
}
