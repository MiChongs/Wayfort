"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { userService } from "@/lib/api/services"
import type { User } from "@/lib/api/types"

// UserPicker — a searchable user list used for delegating an approval task to a
// colleague. Debounces the search and renders display name + username so the
// approver picks the right person, not a numeric id.
export function UserPicker({
  excludeId,
  onPick,
}: {
  excludeId?: number
  onPick: (u: User) => void
}) {
  const [search, setSearch] = React.useState("")
  const [debounced, setDebounced] = React.useState("")
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(t)
  }, [search])

  const q = useQuery({
    queryKey: ["user-picker", debounced],
    queryFn: () => userService.list({ search: debounced || undefined, disabled: "false", limit: 30 }),
    staleTime: 30_000,
  })
  const users = (q.data?.users ?? []).filter((u) => u.id !== excludeId)

  return (
    <Command shouldFilter={false} className="rounded-lg border">
      <CommandInput placeholder="搜索用户（姓名 / 用户名）" value={search} onValueChange={setSearch} />
      <CommandList>
        {q.isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">加载中…</div>
        ) : users.length === 0 ? (
          <CommandEmpty>没有匹配的用户</CommandEmpty>
        ) : (
          <CommandGroup>
            {users.map((u) => (
              <CommandItem key={u.id} value={String(u.id)} onSelect={() => onPick(u)} className="gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-muted text-xs font-medium">
                  {(u.display_name || u.username || "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{u.display_name || u.username}</span>
                  <span className="block truncate text-xs text-muted-foreground">@{u.username}</span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  )
}
