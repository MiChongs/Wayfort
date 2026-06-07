import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "border-border text-foreground",
        success: "border-transparent bg-success/15 text-success",
        warning: "border-transparent bg-warning/18 text-warning",
        // Cream pill — quiet metadata chips (DESIGN badge-pill). Pairs with
        // `rounded-full` at the call site for the pill silhouette.
        soft: "border-transparent bg-accent text-accent-foreground",
        // Coral-tinted — credential "in use" / brand-emphasis chips.
        coral: "border-transparent bg-primary/12 text-primary",
        info: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

function Badge({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof badgeVariants>) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}
export { Badge, badgeVariants }
