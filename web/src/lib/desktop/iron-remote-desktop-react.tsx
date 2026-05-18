"use client"

// Thin React wrapper around the <iron-remote-desktop> Web Component
// shipped by @devolutions/iron-remote-desktop. The component itself is
// vanilla (Svelte-built custom element); this wrapper handles three
// React-specific concerns:
//
//   1. Side-effecting the custom-element registration on mount (the
//      package side-effects window.customElements.define when the
//      module is imported, so a dynamic import is enough).
//   2. Property binding: React maps unknown attributes to string DOM
//      attributes by default, but `module` is a Backend object and
//      can't go through DOM strings — we assign it via element ref.
//   3. Exposing the UserInteraction handle to the parent through a
//      callback prop after the element fires its `ready` event.

import * as React from "react"
import type { UserInteraction } from "@devolutions/iron-remote-desktop"

// IronRdpModule is the RDP backend module exposed by
// `@devolutions/iron-remote-desktop-rdp.Backend`. We don't import the
// concrete type here so SSR builds don't try to load the WASM-backed
// package — the parent passes whatever it loaded in a `useEffect`.
export type IronRdpModule = unknown

export interface IronRemoteDesktopReactProps {
	/** Backend module from `@devolutions/iron-remote-desktop-rdp.Backend`. */
	module: IronRdpModule | null
	/** Fires once the custom element initialises and hands us UserInteraction. */
	onReady?: (ui: UserInteraction) => void
	/** Fires when iron-remote-desktop emits an error event (connect / runtime). */
	onError?: (err: unknown) => void
	/** "fit" (resize-to-fill, default), "real" (1:1 pixels), "full" (stretch). */
	scale?: "fit" | "real" | "full"
	/** When true, the canvas is auto-centred in its container. */
	flexcenter?: boolean
	/** WASM-side debug log level. */
	debugWasm?: "OFF" | "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE"
	/** Verbose JS-side logging. */
	verbose?: boolean
	className?: string
	style?: React.CSSProperties
}

/**
 * IronRemoteDesktopReact renders the `<iron-remote-desktop>` custom
 * element and binds props that have to flow through DOM properties
 * instead of attributes (`module`, the backend module object).
 *
 * The element is only mounted on the client — the parent should
 * gate this component behind a `dynamic(() => ..., { ssr: false })`
 * import to keep the WASM-importing rdp backend out of the server
 * bundle. We re-confirm with a `typeof window !== 'undefined'`
 * guard so even an accidental SSR run yields a null render
 * instead of crashing on `customElements`.
 */
export function IronRemoteDesktopReact(props: IronRemoteDesktopReactProps): React.ReactElement | null {
	const { module, onReady, onError, scale, flexcenter, debugWasm, verbose, className, style } = props
	const ref = React.useRef<HTMLElement | null>(null)
	const onReadyRef = React.useRef(onReady)
	const onErrorRef = React.useRef(onError)

	React.useEffect(() => {
		onReadyRef.current = onReady
		onErrorRef.current = onError
	}, [onReady, onError])

	React.useEffect(() => {
		const el = ref.current
		if (!el || !module) return

		// `module` is an object — assign it as a DOM property so the
		// Web Component sees the actual Backend reference rather than
		// "[object Object]" string coerced by React's attribute path.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(el as any).module = module

		const handleReady = (event: Event) => {
			const detail = (event as CustomEvent).detail as { irgUserInteraction?: UserInteraction }
			if (detail?.irgUserInteraction) {
				onReadyRef.current?.(detail.irgUserInteraction)
			}
		}
		const handleError = (event: Event) => {
			const detail = (event as CustomEvent).detail
			onErrorRef.current?.(detail)
		}

		el.addEventListener("ready", handleReady)
		el.addEventListener("error", handleError)
		return () => {
			el.removeEventListener("ready", handleReady)
			el.removeEventListener("error", handleError)
		}
	}, [module])

	if (typeof window === "undefined") return null

	// Custom element JSX is typed via the module-augmentation in
	// `iron-remote-desktop-jsx.d.ts`. Attributes go through React's
	// string serialisation path — booleans become "true"/"false"
	// strings, which is what the underlying Svelte component expects.
	return (
		<iron-remote-desktop
			ref={ref as React.Ref<HTMLElement>}
			scale={scale ?? "fit"}
			flexcenter={flexcenter === false ? "false" : "true"}
			debugwasm={debugWasm ?? "OFF"}
			verbose={verbose ? "true" : "false"}
			class={className}
			style={style as React.CSSProperties}
		/>
	)
}
