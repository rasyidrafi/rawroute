import * as React from "react"
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "./utils"

const Autocomplete = AutocompletePrimitive.Root

function AutocompleteInputGroup({ className, ...props }: AutocompletePrimitive.InputGroup.Props) {
  return <AutocompletePrimitive.InputGroup data-slot="autocomplete-input-group" className={cn("relative flex w-full items-center", className)} {...props} />
}

function AutocompleteInput({ className, ...props }: AutocompletePrimitive.Input.Props) {
  return <AutocompletePrimitive.Input data-slot="autocomplete-input" className={cn("h-8 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pr-9 pl-2.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80", className)} {...props} />
}

function AutocompleteTrigger({ className, children, ...props }: AutocompletePrimitive.Trigger.Props) {
  return <AutocompletePrimitive.Trigger data-slot="autocomplete-trigger" aria-label="Show suggestions" className={cn("absolute right-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4", className)} {...props}>{children || <ChevronDownIcon />}</AutocompletePrimitive.Trigger>
}

function AutocompletePortal({ ...props }: AutocompletePrimitive.Portal.Props) {
  return <AutocompletePrimitive.Portal data-slot="autocomplete-portal" {...props} />
}

function AutocompletePositioner({ className, side = "bottom", sideOffset = 4, ...props }: AutocompletePrimitive.Positioner.Props) {
  return <AutocompletePrimitive.Positioner data-slot="autocomplete-positioner" side={side} sideOffset={sideOffset} className={cn("z-50 outline-none", className)} {...props} />
}

function AutocompletePopup({ className, ...props }: AutocompletePrimitive.Popup.Props) {
  return <AutocompletePrimitive.Popup data-slot="autocomplete-popup" className={cn("z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none", className)} {...props} />
}

function AutocompleteEmpty({ className, ...props }: AutocompletePrimitive.Empty.Props) {
  return <AutocompletePrimitive.Empty data-slot="autocomplete-empty" className={cn("px-3 py-2 text-sm text-muted-foreground", className)} {...props} />
}

function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
  return <AutocompletePrimitive.List data-slot="autocomplete-list" className={cn("max-h-60 scroll-py-1 overflow-y-auto p-1 outline-none", className)} {...props} />
}

function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
  return <AutocompletePrimitive.Item data-slot="autocomplete-item" className={cn("relative flex w-full cursor-default items-center rounded-md px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground", className)} {...props} />
}

export { Autocomplete, AutocompleteEmpty, AutocompleteInput, AutocompleteInputGroup, AutocompleteItem, AutocompleteList, AutocompletePopup, AutocompletePortal, AutocompletePositioner, AutocompleteTrigger }
