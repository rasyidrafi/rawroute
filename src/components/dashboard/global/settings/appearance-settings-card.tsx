import { MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldTitle } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

const themes = [
  { value: "light", label: "Light Mode", icon: SunIcon },
  { value: "dark", label: "Dark Mode", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
]

export function AppearanceSettingsCard({ theme, onThemeChange, loading = false }: { theme?: string; onThemeChange?: (theme: string) => void; loading?: boolean }) {
  return <Card>
    <CardHeader><CardTitle variant="icon"><PaletteIcon aria-hidden="true" />Appearance</CardTitle><CardDescription>Choose how RawRoute looks on this browser.</CardDescription></CardHeader>
    <CardContent>
      <FieldGroup><Field data-disabled={loading}>
        <FieldTitle id="color-theme-label">Color theme</FieldTitle>
        <ToggleGroup aria-labelledby="color-theme-label" aria-describedby="color-theme-description" variant="outline" size="tile" className="w-full" disabled={loading} value={theme ? [theme] : []} onValueChange={values => { if (values[0]) onThemeChange?.(values[0]) }}>
          {themes.map(({ value, label, icon: Icon }) => <ToggleGroupItem key={value} value={value} aria-label={label}><Icon aria-hidden="true" /><span className="whitespace-normal">{label}</span></ToggleGroupItem>)}
        </ToggleGroup>
        <FieldDescription id="color-theme-description">Saved automatically. System follows your device’s appearance.</FieldDescription>
      </Field></FieldGroup>
    </CardContent>
  </Card>
}
