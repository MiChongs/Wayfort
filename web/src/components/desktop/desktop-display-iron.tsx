"use client"

// IronRdpDesktopShell — Plan 29 PR-B renderer. Wraps the
// <iron-remote-desktop> Web Component (running the Devolutions Rust
// IronRDP client as WebAssembly inside the browser) with the same
// shadcn-styled toolbar / status bar / settings drawer / command
// palette / context menu shell as the legacy DesktopDisplay.
//
// Lifecycle (no in-house WebSocket / FrameClient / OffscreenCanvas):
//
//   1. POST /api/v1/desktop/sessions   → returns {gateway_url, token,
//      destination, username, password, domain, …}.
//   2. <iron-remote-desktop> initialises its Wasm backend, fires
//      `ready` event with a UserInteraction handle.
//   3. Build Config via configBuilder, call `ui.connect(config)`.
//   4. Browser opens WebSocket to Devolutions Gateway, talks RDP
//      directly to the target host. Canvas / input / clipboard are
//      handled internally by the Wasm component.
//
// All the lifecycle baggage from PR #21–#28 (LiveCache, Strict-Mode
// remount survival, BIO_read diagnostics, etc.) is gone — the
// upstream Wasm component owns the data plane, so there's no in-flight
// state for React Strict-Mode to corrupt.

import * as React from "react"
import dynamic from "next/dynamic"
import { useReducedMotion } from "motion/react"
import { toast } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { desktopControl } from "@/lib/desktop/control-client"
import { nodeService } from "@/lib/api/services"
import { patchRdpProtoOptions } from "@/lib/desktop/proto-options"
import { useWorkspaceStore } from "@/components/workspace/useWorkspaceStore"
import {
	buildIronRdpConfig,
	type IronRdpStartSessionPayload,
} from "@/lib/desktop/iron-session"
import type { StartSessionResponse } from "@/lib/desktop/types"
import type { UserInteraction } from "@devolutions/iron-remote-desktop"
import { cn } from "@/lib/utils"
import { DesktopCommandPalette } from "./desktop-command-palette"
import { DesktopContextMenu } from "./desktop-context-menu"
import { DesktopLoadingOverlay } from "./desktop-loading-overlay"
import { DesktopSettingsSheet } from "./desktop-settings-sheet"
import { DesktopStatusBar } from "./desktop-status-bar"
import { DesktopToolbar } from "./desktop-toolbar"
import { useDesktopSettings } from "./use-desktop-settings"
import type { DesktopStatus, SessionStats } from "./desktop-types"

// Lazy-load the iron-remote-desktop React wrapper so the Wasm-bearing
// rdp backend module is excluded from the SSR bundle and only fetched
// when an RDP node is actually opened. Saves ~1.5MB initial JS.
const IronRemoteDesktopReact = dynamic(
	() => import("@/lib/desktop/iron-remote-desktop-react").then((m) => m.IronRemoteDesktopReact),
	{ ssr: false, loading: () => null },
)

export interface IronRdpDesktopShellProps {
	nodeId: number
	nodeName?: string
	nodeHost?: string
	nodePort?: number
}

export function IronRdpDesktopShell(props: IronRdpDesktopShellProps): React.ReactElement {
	const { nodeId, nodeName, nodeHost, nodePort } = props
	const { settings, update, reset } = useDesktopSettings()
	useReducedMotion()

	const wrapRef = React.useRef<HTMLDivElement | null>(null)
	const uiRef = React.useRef<UserInteraction | null>(null)
	const sessionIdRef = React.useRef<string>("")
	const startedRef = React.useRef(false)
	// Lazy holder for the Wasm-backed RDP module + extension factories.
	// We resolve it once per tab — the module import is async so the
	// `ready` handler waits for both this and the UserInteraction handle
	// before kicking off the connect call.
	const [rdpModule, setRdpModule] = React.useState<unknown | null>(null)
	const [rdpExtensions, setRdpExtensions] = React.useState<{
		displayControl: (enable: boolean) => unknown
	} | null>(null)
	const [pendingPayload, setPendingPayload] = React.useState<IronRdpStartSessionPayload | null>(null)

	const [status, setStatus] = React.useState<DesktopStatus>("loading-script")
	const [startedAt, setStartedAt] = React.useState<number>(() => Date.now())
	const [errorInfo, setErrorInfo] = React.useState<{ message: string; code?: number } | undefined>()
	const [fullscreen, setFullscreen] = React.useState(false)
	const [settingsOpen, setSettingsOpen] = React.useState(false)
	const [paletteOpen, setPaletteOpen] = React.useState(false)
	const [remote, setRemote] = React.useState({ w: 1280, h: 720 })
	const [pointer] = React.useState({ x: 0, y: 0 })
	const [stats] = React.useState<SessionStats>({ bytesIn: 0, bytesOut: 0, latencyMs: null, fps: null })
	const [bumpKey, setBumpKey] = React.useState(0)

	// Drive the elapsed-time text on the loading overlay.
	const [, force] = React.useState(0)
	React.useEffect(() => {
		if (status === "connected" || status === "error" || status === "closed") return
		const t = window.setInterval(() => force((v) => v + 1), 250)
		return () => window.clearInterval(t)
	}, [status])

	// Fullscreen subscription (matches the legacy shell so the toolbar
	// "全屏" button keeps working without protocol-specific wiring).
	React.useEffect(() => {
		const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current)
		document.addEventListener("fullscreenchange", onChange)
		return () => document.removeEventListener("fullscreenchange", onChange)
	}, [])

	// Resolve the Wasm RDP backend module once. The package itself
	// side-effects when imported; we only need the Backend reference
	// for the Web Component's `module` attribute and the extension
	// factories for ConfigBuilder. SSR-safe via the `typeof window`
	// guard upstream + dynamic import.
	React.useEffect(() => {
		let cancelled = false
		import("@devolutions/iron-remote-desktop-rdp").then((mod) => {
			if (cancelled) return
			setRdpModule(mod.Backend)
			setRdpExtensions({ displayControl: mod.displayControl })
		}).catch((err) => {
			if (cancelled) return
			toast.error("加载 IronRDP 模块失败", { description: (err as Error).message })
			setStatus("error")
			setErrorInfo({ message: (err as Error).message })
		})
		return () => {
			cancelled = true
		}
	}, [])

	// Connect lifecycle: start a session on our gateway whenever the
	// node / bumpKey changes, store the payload, wait for the Wasm
	// component to be ready, then issue ui.connect(config).
	React.useEffect(() => {
		let cancelled = false
		setStatus("loading-script")
		setStartedAt(Date.now())
		setErrorInfo(undefined)
		startedRef.current = false

		desktopControl
			.startSession({
				node_id: nodeId,
				width: settings.preferredWidth,
				height: settings.preferredHeight,
				dpi: 96,
				quality: "auto",
				backend: "ironrdp",
			})
			.then((resp: StartSessionResponse) => {
				if (cancelled) return
				if (resp.backend !== "ironrdp" || !resp.gateway_url || !resp.token) {
					setStatus("error")
					setErrorInfo({
						message:
							"gateway 返回了非 ironrdp 响应。检查 desktop.devolutions_gateway.enabled 是否为 true",
					})
					return
				}
				sessionIdRef.current = resp.session_id
				setRemote({ w: resp.remote_width || 1280, h: resp.remote_height || 720 })
				setStatus("connecting")
				setPendingPayload({
					gateway_url: resp.gateway_url,
					token: resp.token,
					destination: resp.destination ?? `${nodeHost ?? ""}:${nodePort ?? 3389}`,
					username: resp.username ?? "",
					password: resp.password ?? "",
					domain: resp.domain ?? "",
					remote_width: resp.remote_width,
					remote_height: resp.remote_height,
				})
			})
			.catch((err: Error) => {
				if (cancelled) return
				setStatus("error")
				setErrorInfo({ message: err.message })
			})

		return () => {
			cancelled = true
			// Issue an explicit Wasm-side shutdown before we tear down
			// the React tree so the WebSocket to Devolutions Gateway
			// closes cleanly.
			try {
				uiRef.current?.shutdown()
			} catch {
				/* */
			}
			if (sessionIdRef.current) {
				desktopControl.endSession(sessionIdRef.current).catch(() => {})
				sessionIdRef.current = ""
			}
			uiRef.current = null
			setPendingPayload(null)
			startedRef.current = false
		}
	}, [nodeId, bumpKey, settings.preferredWidth, settings.preferredHeight, nodeHost, nodePort])

	// Once both the Wasm UI handle and the gateway payload are ready,
	// build the Config and connect. Guard with `startedRef` to make
	// re-renders (status updates etc.) idempotent.
	React.useEffect(() => {
		if (startedRef.current) return
		if (!pendingPayload || !uiRef.current || !rdpExtensions) return
		const ui = uiRef.current
		startedRef.current = true
		setStatus("handshake")
		const cfg = buildIronRdpConfig(ui, pendingPayload, rdpExtensions)
		ui.connect(cfg)
			.then(() => {
				setStatus("connected")
				setErrorInfo(undefined)
			})
			.catch((err) => {
				setStatus("error")
				setErrorInfo({ message: ironErrorMessage(err) })
			})
	}, [pendingPayload, rdpExtensions])

	function handleReady(ui: UserInteraction) {
		uiRef.current = ui
	}

	function handleReconnect() {
		setBumpKey((v) => v + 1)
	}

	function handleDisconnect() {
		try {
			uiRef.current?.shutdown()
		} catch {
			/* */
		}
		if (sessionIdRef.current) {
			desktopControl.endSession(sessionIdRef.current).catch(() => {})
			sessionIdRef.current = ""
		}
		setStatus("closed")
	}

	function sendCombo(combo: string) {
		const ui = uiRef.current
		if (!ui) return
		const normalised = combo.toLowerCase().replace(/\s+/g, "")
		if (
			normalised === "control+alt+delete" ||
			normalised === "ctrl+alt+delete" ||
			normalised === "ctrl+alt+del"
		) {
			ui.ctrlAltDel()
			return
		}
		toast.warning("IronRDP 当前只暴露 Ctrl-Alt-Del 等少量组合键", { description: combo })
	}

	function toggleFullscreen() {
		const el = wrapRef.current
		if (!el) return
		if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {})
		else document.exitFullscreen?.().catch(() => {})
	}

	// "切换经典 RDP" — same escape hatch the legacy shell exposes
	// (PR #21). Opens a fresh workspace tab on the Guacamole-backed
	// `rdp` protocol so the operator has a one-click fallback if
	// IronRDP hits a host it doesn't speak well to.
	function handleSwitchToGuacamole() {
		const store = useWorkspaceStore.getState()
		const inWorkspace = typeof store.open === "function" && Array.isArray(store.tabs)
		if (inWorkspace) {
			store.open({
				nodeId,
				protocol: "rdp",
				title: nodeName || `node #${nodeId}`,
				host: nodeHost,
				port: nodePort,
			})
			toast.success("已在工作台开启经典 RDP 会话", {
				description: "通过 Guacamole 通道连接,通常更稳定",
			})
			return
		}
		if (typeof window !== "undefined") {
			window.location.assign(`/nodes/${nodeId}/rdp`)
		}
	}

	async function handleForceTlsOnly() {
		try {
			const node = await nodeService.get(nodeId)
			const next = patchRdpProtoOptions(node.proto_options, { security: "tls" })
			await nodeService.update(nodeId, { proto_options: next })
			toast.success("已切换到仅 TLS,正在重连…")
			handleReconnect()
		} catch (e) {
			toast.error("切换失败", { description: (e as Error).message })
		}
	}

	return (
		<TooltipProvider delayDuration={300}>
			<div
				ref={wrapRef}
				className={cn("flex flex-col h-full w-full bg-background isolate", fullscreen && "fixed inset-0 z-[60]")}
			>
				<DesktopToolbar
					status={status}
					nodeName={nodeName}
					nodeId={nodeId}
					nodeHost={nodeHost}
					nodePort={nodePort}
					remoteWidth={remote.w}
					remoteHeight={remote.h}
					fullscreen={fullscreen}
					onSendCombo={sendCombo}
					onSendCtrlAltDel={() => sendCombo("Control+Alt+Delete")}
					onSettings={() => setSettingsOpen(true)}
					onPalette={() => setPaletteOpen(true)}
					onFullscreen={toggleFullscreen}
					onReconnect={handleReconnect}
					onDisconnect={handleDisconnect}
				/>

				<DesktopContextMenu
					connected={status === "connected"}
					onSendCombo={sendCombo}
					onFullscreen={toggleFullscreen}
					onSettings={() => setSettingsOpen(true)}
					onPalette={() => setPaletteOpen(true)}
					onReconnect={handleReconnect}
					onDisconnect={handleDisconnect}
				>
					<div className="relative flex-1 min-h-0 bg-black flex">
						<IronRemoteDesktopReact
							module={rdpModule}
							onReady={handleReady}
							onError={(err) => {
								setStatus("error")
								setErrorInfo({ message: ironErrorMessage(err) })
							}}
							scale={mapScaleMode(settings.scaleMode)}
							flexcenter
							className="flex-1 min-h-0"
						/>
						<DesktopLoadingOverlay
							status={status}
							errorMessage={errorInfo?.message}
							errorCode={errorInfo?.code}
							elapsedMs={Date.now() - startedAt}
							nodeName={nodeName}
							onRetry={handleReconnect}
							onForceTlsOnly={handleForceTlsOnly}
							onSwitchToGuacamole={handleSwitchToGuacamole}
						/>
					</div>
				</DesktopContextMenu>

				<DesktopStatusBar
					status={status}
					remoteWidth={remote.w}
					remoteHeight={remote.h}
					pointerX={pointer.x}
					pointerY={pointer.y}
					stats={stats}
					keyboardLayout={settings.keyboardLayout}
				/>

				<DesktopSettingsSheet
					open={settingsOpen}
					onOpenChange={setSettingsOpen}
					settings={settings}
					onChange={update}
					onReset={reset}
				/>

				<DesktopCommandPalette
					open={paletteOpen}
					onOpenChange={setPaletteOpen}
					actions={{
						onSendCombo: sendCombo,
						onFullscreen: toggleFullscreen,
						onSettings: () => setSettingsOpen(true),
						onReconnect: handleReconnect,
						onDisconnect: handleDisconnect,
					}}
				/>
			</div>
		</TooltipProvider>
	)
}

// mapScaleMode converts our `DesktopSettings.scaleMode` enum into
// iron-remote-desktop's `scale` attribute domain. The Wasm component
// only supports three modes (fit / real / full), so we collapse our
// four-way enum onto those:
//   - "fit"      → "fit"  (default; aspect-ratio-preserving fit)
//   - "actual"   → "real" (1:1 pixel mapping)
//   - "stretch"  → "full" (fill container, may distort)
//   - "center"   → "real" (closest match — iron has no centred mode)
function mapScaleMode(mode: "fit" | "actual" | "center" | "stretch"): "fit" | "real" | "full" {
	switch (mode) {
		case "actual":
			return "real"
		case "stretch":
			return "full"
		case "center":
			return "real"
		default:
			return "fit"
	}
}

// ironErrorMessage extracts the human bits out of whatever
// IronRDP / Devolutions Gateway threw — its IronError type has a
// `.kind()` enum + `.backtrace()` text, but vanilla JS errors and
// network rejections come through as Error / DOMException.
function ironErrorMessage(err: unknown): string {
	if (!err) return "未知错误"
	if (typeof err === "string") return err
	const e = err as { kind?: () => unknown; backtrace?: () => string; message?: string }
	const parts: string[] = []
	if (typeof e.kind === "function") {
		try {
			parts.push(String(e.kind()))
		} catch {
			/* */
		}
	}
	if (typeof e.message === "string" && e.message) parts.push(e.message)
	if (typeof e.backtrace === "function") {
		try {
			const bt = e.backtrace()
			if (bt) parts.push(bt)
		} catch {
			/* */
		}
	}
	return parts.length > 0 ? parts.join(" — ") : String(err)
}
