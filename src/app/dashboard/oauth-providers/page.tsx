import { redirect } from "next/navigation"

export default function OAuthProvidersRedirect() {
  redirect("/dashboard/providers/codex")
}
