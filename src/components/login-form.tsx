import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
import { KeyRoundIcon, RouteIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { LoadingSpinner } from "@/components/loading-spinner"
import { useSession } from "@/hooks/use-session"

export function LoginForm() {
  const navigate = useNavigate()
  const { mutate: refreshSession } = useSession()
  const [loading, setLoading] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    try {
      const formData = new FormData(event.currentTarget)
      const minimumSpinnerTime = new Promise((resolve) => setTimeout(resolve, 350))
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(formData)),
      })
      const result = await response.json()
      await minimumSpinnerTime
      if (!response.ok) {
        toast.error(result.error?.message || "Login failed")
        return
      }
      await refreshSession()
      navigate("/dashboard", { replace: true })
    } catch {
      toast.error("Unable to reach the gateway")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card variant="login">
      <CardHeader variant="spacious">
        <div className="flex size-11 items-center justify-center rounded-xl bg-console text-white">
          <RouteIcon className="size-5" />
        </div>
        <div>
          <CardTitle variant="page">RawRoute</CardTitle>
          <CardDescription className="mt-2">A protocol-preserving gateway for your model providers.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="username">Username</FieldLabel>
              <Input id="username" name="username" defaultValue="admin" autoComplete="username" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input id="password" name="password" type="password" placeholder="Default: change-me-now" autoComplete="current-password" required />
            </Field>
            <Button aria-busy={loading} disabled={loading} type="submit" className="w-full">
              {loading ? <LoadingSpinner /> : <KeyRoundIcon />} {loading ? "Signing in..." : "Sign in"}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
