import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"

export function InstanceSettingsSkeleton() {
  return <FieldGroup aria-busy="true" aria-label="Loading gateway settings">
    {["Debug logging", "File logging", "Usage statistics"].map(label => <Field key={label} orientation="horizontal"><Skeleton className="size-4 shrink-0" /><FieldLabel>{label}</FieldLabel></Field>)}
    {["Request retry count", "Maximum retry interval (seconds)", "Routing strategy"].map(label => <Field key={label}><FieldLabel>{label}</FieldLabel><Skeleton className="h-8 w-full" />{label === "Routing strategy" && <p className="text-sm text-muted-foreground">RawRoute manages fill-first routing to preserve provider key priority.</p>}</Field>)}
    <div><Skeleton className="h-8 w-28" /></div>
  </FieldGroup>
}
