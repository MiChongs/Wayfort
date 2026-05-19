"use client"

// Sonner Toaster wrapped in the shadcn New York way. Earlier revisions
// of this file fought sonner with `unstyled: true` + per-slot classNames,
// which left dark-mode toasts looking like flat black rows because our
// `bg-destructive/5` overlay was invisible against `bg-background`. The
// upstream-recommended path — and the one shadcn ships in its CLI — is
// the opposite: keep sonner's internal styles ON, and only rebind its
// CSS variables (`--normal-bg`, `--success-bg`, `--error-bg`, …) to our
// design tokens. Sonner then renders its own polished surface, including
// the close button and tone palette, but every colour and radius lands
// inside the shadcn vocabulary.
//
// Per-tone backgrounds, foregrounds, and borders are defined in
// `globals.css` (`--toast-{tone}-bg/-text/-border`) for light + dark
// themes so the values cascade through `.dark`. Entry / exit motion
// keyframes are also in globals.css, calibrated to motion-spring(300, 28).
//
// next-themes' `resolvedTheme` is forwarded so sonner's own `theme=`
// attribute flips with the rest of the app.

import * as React from "react"
import { Toaster as SonnerToaster, toast, type ToasterProps } from "sonner"
import { useTheme } from "next-themes"
import {
	AlertTriangle,
	CheckCircle2,
	Info,
	Loader2,
	XCircle,
} from "lucide-react"
import { cn } from "@/lib/utils"

const ICON = "size-4 shrink-0"

export function Toaster(props: Omit<ToasterProps, "theme">) {
	const { resolvedTheme } = useTheme()
	const theme = (resolvedTheme ?? "system") as ToasterProps["theme"]

	return (
		<SonnerToaster
			theme={theme}
			position="top-right"
			closeButton
			richColors
			visibleToasts={5}
			gap={10}
			offset={16}
			expand
			// Match the rest of the app's icons. Tone color flows through
			// `currentColor`, which sonner sets from `--{tone}-text`.
			icons={{
				success: <CheckCircle2 className={ICON} aria-hidden />,
				error: <XCircle className={ICON} aria-hidden />,
				warning: <AlertTriangle className={ICON} aria-hidden />,
				info: <Info className={ICON} aria-hidden />,
				loading: (
					<Loader2 className={cn(ICON, "animate-spin")} aria-hidden />
				),
			}}
			// Rebind sonner's CSS variables to our shadcn tokens. The
			// `--toast-{tone}-*` triples come from globals.css and already
			// carry the light/dark variants, so this stays static.
			style={
				{
					"--width": "400px",
					"--border-radius": "var(--radius)",
					"--font-family":
						"var(--font-sans, ui-sans-serif, system-ui, sans-serif)",
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "var(--border)",
					"--success-bg": "var(--toast-success-bg)",
					"--success-text": "var(--toast-success-text)",
					"--success-border": "var(--toast-success-border)",
					"--error-bg": "var(--toast-error-bg)",
					"--error-text": "var(--toast-error-text)",
					"--error-border": "var(--toast-error-border)",
					"--warning-bg": "var(--toast-warning-bg)",
					"--warning-text": "var(--toast-warning-text)",
					"--warning-border": "var(--toast-warning-border)",
					"--info-bg": "var(--toast-info-bg)",
					"--info-text": "var(--toast-info-text)",
					"--info-border": "var(--toast-info-border)",
				} as React.CSSProperties
			}
			toastOptions={{
				classNames: {
					// Sonner's own styles handle layout + padding. We add
					// shadcn polish: stronger shadow, subtle ring for the
					// glass edge, backdrop blur so toasts read on top of
					// terminal / desktop canvases.
					toast: cn(
						"group/toast !rounded-[var(--radius)] !shadow-lg !shadow-black/[0.08]",
						"ring-1 ring-black/[0.04] dark:ring-white/[0.06]",
						"backdrop-blur-md",
					),
					title: "!text-[13px] !font-medium !leading-tight",
					description:
						"!text-[12px] !leading-relaxed !opacity-90 !mt-0.5 [&_p]:!leading-relaxed",
					actionButton: cn(
						"!inline-flex !h-7 !items-center !justify-center !rounded-md !px-3",
						"!text-xs !font-medium",
						"!bg-foreground !text-background !shadow-xs",
						"hover:!bg-foreground/90",
						"focus-visible:!outline-none focus-visible:!ring-2 focus-visible:!ring-ring/50",
					),
					cancelButton: cn(
						"!inline-flex !h-7 !items-center !justify-center !rounded-md !px-3",
						"!text-xs !font-medium",
						"!border !border-border !bg-background !shadow-xs",
						"hover:!bg-accent hover:!text-accent-foreground",
						"focus-visible:!outline-none focus-visible:!ring-2 focus-visible:!ring-ring/50",
					),
					// Sonner ships a serviceable close button — we only
					// tone down its visual weight so it doesn't compete
					// with the title. The `:not(:hover)` opacity makes it
					// recede until the cursor approaches.
					closeButton: cn(
						"!size-5 !rounded-md !border-0 !bg-transparent",
						"!text-current/60 hover:!text-current",
						"hover:!bg-current/10",
						"focus-visible:!outline-none focus-visible:!ring-2 focus-visible:!ring-ring/50",
					),
				},
			}}
			{...props}
		/>
	)
}

// Re-export sonner's `toast` so new callsites can prefer the single
// shadcn entry point. Existing 149 callsites that import from "sonner"
// keep working unchanged — both flow through the same Toaster mount.
export { toast }
