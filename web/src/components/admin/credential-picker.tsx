"use client"

// CredentialPicker — a searchable credential combobox with inline create.
//
// Replaces the bare <Select> credential dropdowns scattered across the node /
// proxy create sheets. Searching matches name / username / tags; the footer
// "新建凭据…" opens the full CredentialFormSheet and auto-selects the result,
// so operators never have to bail out of a half-filled node form to go make a
// credential first.

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronsUpDown, FileKey2, KeyRound, Lock, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CredentialFormSheet } from "@/components/admin/credential-form-sheet"
import { credentialService } from "@/lib/api/services"
import type { Credential } from "@/lib/api/types"

const CREDS_KEY = ["admin", "credentials"] as const

function KindIcon({ kind, className }: { kind: Credential["kind"]; className?: string }) {
  const Icon = kind === "private_key" ? FileKey2 : kind === "agent" ? KeyRound : Lock
  return <Icon className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", className)} />
}

export interface CredentialPickerProps {
  value?: number | null
  onChange: (id: number | null) => void
  allowNone?: boolean
  placeholder?: string
  className?: string
  id?: string
  "aria-invalid"?: boolean
}

export function CredentialPicker({
  value,
  onChange,
  allowNone = false,
  placeholder = "选择凭据",
  className,
  id,
  "aria-invalid": ariaInvalid,
}: CredentialPickerProps) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: CREDS_KEY, queryFn: credentialService.list })
  const [open, setOpen] = React.useState(false)
  const [creating, setCreating] = React.useState(false)

  const creds = q.data?.credentials ?? []
  const selected = creds.find((c) => c.id === value) ?? null

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={ariaInvalid}
            className={cn("w-full justify-between font-normal", !selected && "text-muted-foreground", className)}
          >
            <span className="flex min-w-0 items-center gap-2 truncate">
              {selected ? (
                <>
                  <KindIcon kind={selected.kind} />
                  <span className="truncate">{selected.name}</span>
                  {selected.username && (
                    <span className="truncate text-xs text-muted-foreground">{selected.username}</span>
                  )}
                </>
              ) : (
                placeholder
              )}
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command>
            <CommandInput placeholder="搜索凭据…" />
            <CommandList>
              <CommandEmpty>未找到匹配的凭据</CommandEmpty>
              <CommandGroup>
                {allowNone && (
                  <CommandItem
                    value="__none__ 不使用凭据"
                    onSelect={() => {
                      onChange(null)
                      setOpen(false)
                    }}
                  >
                    <span className="text-muted-foreground">不使用凭据</span>
                    {value == null && <Check className="ml-auto h-4 w-4" />}
                  </CommandItem>
                )}
                {creds.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`${c.name} ${c.username} ${c.tags ?? ""} #${c.id}`}
                    onSelect={() => {
                      onChange(c.id)
                      setOpen(false)
                    }}
                  >
                    <KindIcon kind={c.kind} />
                    <span className="truncate">{c.name}</span>
                    {c.username && <span className="truncate text-xs text-muted-foreground">{c.username}</span>}
                    {value === c.id && <Check className="ml-auto h-4 w-4" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            <div className="border-t p-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-foreground"
                onClick={() => {
                  setOpen(false)
                  setCreating(true)
                }}
              >
                <Plus className="h-4 w-4" /> 新建凭据…
              </Button>
            </div>
          </Command>
        </PopoverContent>
      </Popover>

      {creating && (
        <CredentialFormSheet
          open
          onOpenChange={(v) => !v && setCreating(false)}
          onSaved={(newId) => {
            qc.invalidateQueries({ queryKey: CREDS_KEY })
            onChange(newId)
            setCreating(false)
          }}
        />
      )}
    </>
  )
}
