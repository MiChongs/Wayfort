// Facade that turns our backend's `/desktop/sessions` response into an
// IronRDP Config and drives the connect lifecycle. Kept separate from
// the React component so it can be unit-tested without DOM.

import type { UserInteraction, NewSessionInfo } from "@devolutions/iron-remote-desktop"

// `Config` and `ConfigBuilder` are declared but not exported by the
// package. Derive them through the public `UserInteraction` surface so
// callers don't have to import private types.
type IronRdpConfigBuilder = ReturnType<UserInteraction["configBuilder"]>
type IronRdpConfig = ReturnType<IronRdpConfigBuilder["build"]>

/**
 * IronRdpStartSessionPayload mirrors the ironrdp fields the Go gateway
 * adds to /api/v1/desktop/sessions when backend=ironrdp.
 *
 * - `gateway_url`  WebSocket URL the browser opens to Devolutions Gateway
 *                  (e.g. ws://localhost:7171/jet/rdp)
 * - `token`        Short-lived RS256 JWT the gateway pre-authorises with.
 *                  Format documented in MS / Devolutions cookbook
 *                  (jet_cm=fwd, jet_ap=rdp, dst_hst=<host:port>).
 * - `destination`  Target RDP host:port the gateway should TCP-connect to.
 * - `username` / `password` / `domain` flow through the Wasm RDP client to
 *                the target host as standard NLA/TLS credentials.
 */
export interface IronRdpStartSessionPayload {
	gateway_url: string
	token: string
	destination: string
	username: string
	password: string
	domain?: string
	remote_width?: number
	remote_height?: number
}

export interface IronRdpExtensionFactories {
	displayControl: (enable: boolean) => unknown
}

/**
 * Build an IronRDP Config from a payload + UI handle. Extensions are
 * passed in so the caller (which already loaded the rdp backend module
 * lazily) controls when they're created.
 *
 * `displayControl(true)` enables MS-RDPEDISP server-side resize. We
 * always enable it: the browser viewport changes are part of the basic
 * usable feature set.
 */
export function buildIronRdpConfig(
	ui: UserInteraction,
	payload: IronRdpStartSessionPayload,
	exts: IronRdpExtensionFactories,
): IronRdpConfig {
	const builder = ui
		.configBuilder()
		.withUsername(payload.username)
		.withPassword(payload.password)
		.withDestination(payload.destination)
		.withProxyAddress(payload.gateway_url)
		.withAuthToken(payload.token)
		.withServerDomain(payload.domain ?? "")
		.withExtension(exts.displayControl(true))
	if (payload.remote_width && payload.remote_height) {
		builder.withDesktopSize({
			width: payload.remote_width,
			height: payload.remote_height,
		})
	}
	return builder.build()
}

export type ConnectOutcome =
	| { ok: true; info: NewSessionInfo }
	| { ok: false; error: unknown }

/**
 * Issue a connect and translate the promise rejection path into a value
 * the caller can branch on without try/catch boilerplate at every
 * call-site.
 */
export async function connectIronRdp(
	ui: UserInteraction,
	config: IronRdpConfig,
): Promise<ConnectOutcome> {
	try {
		const info = await ui.connect(config)
		return { ok: true, info }
	} catch (error) {
		return { ok: false, error }
	}
}
