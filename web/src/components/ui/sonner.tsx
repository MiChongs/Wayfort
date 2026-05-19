"use client"

// Sonner Toaster wrapped to match the project's shadcn New York design
// language. The upstream `<Toaster>` renders its own DOM with default
// styles — we set `unstyled: true` and feed Tailwind classNames per slot
// so the rendered toast is indistinguishable from a shadcn `<Alert>`:
// matching radius (--radius), tone palette (emerald/sky/amber/destructive),
// and dark-mode tints. next-themes' resolvedTheme is forwarded so the
// Toaster's own `theme` data attribute flips with the rest of the app.
//
// Animations are not styled here — they live in globals.css against
// the data-attributes sonner sets on each toast root. Those keyframes
// approximate motion(spring 300/28) so the entry/exit feel native to
// the rest of the workspace v2 surface.
//
// Callsites keep importing `toast` from "sonner" unchanged. This file
// also re-exports it for new code that wants a single import.

import * as React from "react"
import {
	Toaster as SonnerToaster,
	toast,
	type ToasterProps,
} from "sonner"
import { useTheme } from "next-themes"
import {
	AlertTriangle,
	CheckCircle2,
	Info,
	Loader2,
	XCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"

// Visual baseline shared by every tone. `pr-10` reserves room for the
// floating close button; `backdrop-blur-sm` keeps the colour overlay
// readable when the toast lands on top of dense content (terminal /
// guacamole / iframe).
const TOAST_BASE =
	"group pointer-events-auto relative flex w-full items-start gap-3 rounded-lg border bg-background p-4 pr-10 text-sm shadow-lg shadow-black/5 backdrop-blur-sm"

// Tone tables mirror web/src/components/ui/alert.tsx so a toast and
// an inline Alert with the same severity look identical side-by-side.
const TONE_DEFAULT =
	"border-border text-foreground [&_[data-icon]]:text-foreground/70"
const TONE_SUCCESS =
	"border-emerald-500/40 bg-emerald-50/40 dark:bg-emerald-950/30 " +
	"text-emerald-900 dark:text-emerald-100 " +
	"[&_[data-icon]]:text-emerald-600 dark:[&_[data-icon]]:text-emerald-400"
const TONE_ERROR =
	"border-destructive/40 bg-destructive/5 text-destructive " +
	"[&_[data-icon]]:text-destructive"
const TONE_WARNING =
	"border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/30 " +
	"text-amber-900 dark:text-amber-100 " +
	"[&_[data-icon]]:text-amber-600 dark:[&_[data-icon]]:text-amber-400"
const TONE_INFO =
	"border-sky-500/40 bg-sky-50/40 dark:bg-sky-950/30 " +
	"text-sky-900 dark:text-sky-100 " +
	"[&_[data-icon]]:text-sky-600 dark:[&_[data-icon]]:text-sky-400"

// Action / cancel buttons reuse the shadcn Button geometry (h-7, px-3,
// rounded-md, text-xs, ring-2 focus-visible). Default uses primary
// surface; cancel uses outline.
const ACTION_BTN = cn(
	"inline-flex h-7 items-center justify-center gap-1 rounded-md px-3 text-xs font-medium",
	"bg-foreground text-background shadow-xs",
	"transition-colors hover:bg-foreground/90",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
	"disabled:pointer-events-none disabled:opacity-50",
)
const CANCEL_BTN = cn(
	"inline-flex h-7 items-center justify-center gap-1 rounded-md px-3 text-xs font-medium",
	"border border-border bg-background shadow-xs",
	"transition-colors hover:bg-accent hover:text-accent-foreground",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
)
const CLOSE_BTN = cn(
	"absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded-md",
	"text-foreground/60",
	"transition-colors hover:bg-accent hover:text-foreground",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
	// Keep close visible without overriding tone text color of the row.
	"group-[.toast]:opacity-70 group-[.toast]:hover:opacity-100",
)

const ICON_BASE = "size-4 shrink-0"

export function Toaster(props: Omit<ToasterProps, "theme">) {
	const { resolvedTheme } = useTheme()
	const theme = (resolvedTheme ?? "system") as ToasterProps["theme"]

	return (
		<SonnerToaster
			theme={theme}
			position="top-right"
			closeButton
			visibleToasts={5}
			gap={10}
			offset={16}
			// Lucide icons match the rest of the app. The `data-icon`
			// attribute lets the per-tone classes recolor the SVG without
			// a separate class string per icon.
			icons={{
				success: <CheckCircle2 className={ICON_BASE} data-icon />,
				error: <XCircle className={ICON_BASE} data-icon />,
				warning: <AlertTriangle className={ICON_BASE} data-icon />,
				info: <Info className={ICON_BASE} data-icon />,
				loading: (
					<Loader2 className={cn(ICON_BASE, "animate-spin")} data-icon />
				),
			}}
			toastOptions={{
				unstyled: true,
				classNames: {
					// Outer row. Tone class is appended via the `default` /
					// `success` / `error` / `warning` / `info` / `loading`
					// per-type slots below — sonner merges them.
					toast: TOAST_BASE,
					default: TONE_DEFAULT,
					success: TONE_SUCCESS,
					error: TONE_ERROR,
					warning: TONE_WARNING,
					info: TONE_INFO,
					loading: TONE_DEFAULT,
					title: "text-sm font-semibold leading-tight",
					description:
						"mt-1 text-xs leading-relaxed opacity-90 [&_p]:leading-relaxed",
					actionButton: ACTION_BTN,
					cancelButton: CANCEL_BTN,
					closeButton: CLOSE_BTN,
					icon: "mt-0.5 shrink-0",
				},
			}}
			{...props}
		/>
	)
}

// Re-export sonner's `toast` from this file so call sites can choose
// between `import { toast } from "sonner"` (status quo, 149 sites) or
// `import { toast } from "@/components/ui/sonner"` (preferred for new
// code). Behaviour is identical; both flow through the single mounted
// `<Toaster />` in providers.tsx.
export { toast }
