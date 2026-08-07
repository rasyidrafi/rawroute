import { listWorkspaces } from "@/lib/workspaces"

export async function GET() {
  const workspaces = (await listWorkspaces())
    .filter((workspace) => workspace.status === "active")
    .map(({ id, name, isDefault }) => ({ id, name, isDefault }))
  return Response.json({ workspaces }, { headers: { "cache-control": "public, max-age=30, s-maxage=30, stale-while-revalidate=120" } })
}
