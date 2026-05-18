// Type declarations that teach TypeScript / JSX about the
// <iron-remote-desktop> custom element registered by
// @devolutions/iron-remote-desktop.
//
// The package side-effects `customElements.define("iron-remote-desktop", …)`
// when imported, but it does NOT register a JSX intrinsic, so TSX without
// this file complains that `iron-remote-desktop` is not a known element.

import type * as React from "react"

declare module "react" {
	namespace JSX {
		interface IntrinsicElements {
			"iron-remote-desktop": React.DetailedHTMLProps<
				React.HTMLAttributes<HTMLElement>,
				HTMLElement
			> & {
				scale?: "fit" | "real" | "full"
				flexcenter?: "true" | "false"
				debugwasm?: "OFF" | "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE"
				verbose?: "true" | "false"
				class?: string
			}
		}
	}
}

export {}
