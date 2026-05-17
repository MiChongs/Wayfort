import { Skeleton } from "@/components/ui/skeleton"

export function SidebarSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="px-2 pt-3 space-y-1">
      <Skeleton className="h-3 w-12 mx-1 mb-2" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-3 py-2 space-y-1.5">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  )
}
