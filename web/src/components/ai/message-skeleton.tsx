import { Skeleton } from "@/components/ui/skeleton"

export function MessageSkeleton() {
  return (
    <div className="space-y-4">
      {/* user */}
      <div className="flex justify-end gap-3 items-start">
        <Skeleton className="h-9 w-48 rounded-2xl" />
        <Skeleton className="w-7 h-7 rounded-full" />
      </div>
      {/* assistant */}
      <div className="flex gap-3 items-start">
        <Skeleton className="w-7 h-7 rounded-full" />
        <div className="flex-1 max-w-3xl rounded-lg border bg-card p-4 space-y-2">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
      <div className="flex justify-end gap-3 items-start">
        <Skeleton className="h-9 w-32 rounded-2xl" />
        <Skeleton className="w-7 h-7 rounded-full" />
      </div>
    </div>
  )
}
