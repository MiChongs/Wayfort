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
import { motion, useReducedMotion } from "motion/react"
import { toast } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PortalContainerProvider } from "@/components/ui/portal-container"
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
import { DesktopConnectionStage } from "./desktop-connection-stage"
import { useDesktopConnection } from "./desktop-connection"
import { DesktopPerfPanel } from "./desktop-perf-panel"
import { DesktopSettingsSheet } from "./desktop-settings-sheet"
import { DesktopToolbar } from "./desktop-toolbar"
import { useDesktopSettings } from "./use-desktop-settings"
import { useDesktopChrome } from "./use-desktop-chrome"
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
	// Callback bridge to the workspace tab (or any parent) so the tab
	// badge / status bar / perf panel can mirror the session state in
	// real time. All three are optional — leaving them undefined is the
	// previous behaviour (no parent observation).
	onStatusChange?: (status: DesktopStatus) => void
	onStatsChange?: (stats: SessionStats) => void
	onLatencyChange?: (ms: number | null) => void
}

export function IronRdpDesktopShell(props: IronRdpDesktopShellProps): React.ReactElement {
	const { nodeId, nodeName, nodeHost, nodePort, onStatusChange, onStatsChange, onLatencyChange } = props
	const { settings, update, reset } = useDesktopSettings()
	const reduceMotion = useReducedMotion()

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

	// Connection state machine — shared with the FreeRDP shell. The Wasm path
	// can't introspect RTT (the socket is owned by the component), so latency /
	// link quality stay "测量中"; everything else (timed step timeline, session
	// clock, reconnect, error classification) works the same.
	const conn = useDesktopConnection()
	const status = conn.status
	const setStatus = conn.setStatus
	const [fullscreen, setFullscreen] = React.useState(false)
	const [settingsOpen, setSettingsOpen] = React.useState(false)
	const [paletteOpen, setPaletteOpen] = React.useState(false)
	const [perfOpen, setPerfOpen] = React.useState(false)
	const [remote, setRemote] = React.useState({ w: 1280, h: 720 })
	// IronRDP path: the WebSocket is owned by the Wasm component
	// (`<iron-remote-desktop>`), so we can't introspect bytes from a
	// FrameClient like the legacy path does. We populate fps via a
	// requestAnimationFrame-driven sampler against the host element,
	// and leave bytesIn/bytesOut/latencyMs as null until the Wasm
	// component exposes them on the `UserInteraction` handle (it
	// doesn't, as of @devolutions/iron-remote-desktop 0.6).
	const [stats, setStats] = React.useState<SessionStats>({
		bytesIn: 0,
		bytesOut: 0,
		latencyMs: null,
		fps: null,
	})
	const [bumpKey, setBumpKey] = React.useState(0)

	// Single auto-hiding control bar (shared with the FreeRDP shell). Owns the
	// wrapper element for the Fullscreen API + the overlay portal target.
	const anyOverlayOpen = settingsOpen || paletteOpen || perfOpen
	// Only auto-hide once connected — while connecting / reconnecting / errored
	// the bar stays pinned so its status + reconnect controls stay reachable.
	const { wrapRef, wrapEl, setWrap, chromeShown, revealChrome, onBarMouseEnter, onBarMouseLeave } =
		useDesktopChrome(fullscreen && status === "connected", anyOverlayOpen)

	// Fullscreen subscription (matches the legacy shell so the toolbar
	// "全屏" button keeps working without protocol-specific wiring).
	React.useEffect(() => {
		const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current)
		document.addEventListener("fullscreenchange", onChange)
		return () => document.removeEventListener("fullscreenchange", onChange)
	}, [])

	// Bridge local lifecycle state out to the parent (workspace tab,
	// perf panel, etc.) via the optional callback props. Each effect
	// fires only when its watched value actually changes, so parents
	// can `setState`/`setStatus` in the callback without thrashing.
	React.useEffect(() => {
		onStatusChange?.(status)
	}, [status, onStatusChange])
	React.useEffect(() => {
		onStatsChange?.(stats)
	}, [stats, onStatsChange])
	React.useEffect(() => {
		onLatencyChange?.(stats.latencyMs)
	}, [stats.latencyMs, onLatencyChange])

	// Keyboard shortcut: Ctrl+Shift+P toggles the perf panel. Matches
	// the convention of the command palette + most browser devtools so
	// users can memorise one binding across protocols. Capture-phase so
	// it wins against the remote desktop's keyboard hook below.
	React.useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
				e.preventDefault()
				setPerfOpen((v) => !v)
			}
		}
		window.addEventListener("keydown", onKey, { capture: true })
		return () => window.removeEventListener("keydown", onKey, { capture: true })
	}, [])

	// Frame-rate sampler — counts requestAnimationFrame callbacks per
	// second while the session is connected. This measures the browser
	// compositor cadence (not the canvas paint rate, which the Wasm
	// component owns), but in practice serves as a usable smoothness
	// proxy: if rAF stays at 60 Hz the UI feels fluid, if it drops the
	// user sees jank either way. Pauses when the tab is hidden because
	// rAF doesn't fire then.
	React.useEffect(() => {
		if (status !== "connected") return
		let frames = 0
		let windowStart = performance.now()
		let raf = 0
		const tick = () => {
			frames++
			const now = performance.now()
			const elapsed = now - windowStart
			if (elapsed >= 1000) {
				const fps = Math.round((frames * 1000) / elapsed)
				setStats((s) => (s.fps === fps ? s : { ...s, fps }))
				frames = 0
				windowStart = now
			}
			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
	}, [status])

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
			conn.fail((err as Error).message)
		})
		return () => {
			cancelled = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Connect lifecycle: start a session on our gateway whenever the
	// node / bumpKey changes, store the payload, wait for the Wasm
	// component to be ready, then issue ui.connect(config).
	React.useEffect(() => {
		let cancelled = false
		conn.restart()
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
					conn.fail(
						"gateway 返回了非 ironrdp 响应。请检查 desktop.devolutions_gateway.enabled 是否为 true",
					)
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
				conn.fail(err.message)
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
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
			})
			.catch((err) => {
				conn.fail(ironErrorMessage(err))
			})
		// eslint-disable-next-line react-hooks/exhaustive-deps
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
				ref={setWrap}
				onMouseMove={fullscreen ? revealChrome : undefined}
				className={cn("relative flex flex-col h-full w-full bg-background isolate", fullscreen && "fixed inset-0 z-[60]")}
			>
				<PortalContainerProvider value={fullscreen ? wrapEl : undefined}>
				{/* Single control bar. Overlays the canvas + auto-hides in
				    fullscreen; pinned in normal flow when windowed. */}
				<motion.div
					className={cn(fullscreen ? "absolute inset-x-0 top-0 z-[70] p-2.5" : "relative z-10 shrink-0")}
					initial={false}
					animate={{ y: chromeShown ? 0 : "-100%", opacity: chromeShown ? 1 : 0 }}
					transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
					style={{ pointerEvents: chromeShown ? "auto" : "none" }}
					onMouseEnter={onBarMouseEnter}
					onMouseLeave={onBarMouseLeave}
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
						backendLabel="IronRDP"
						quality={conn.quality}
						stats={stats}
						sessionMs={conn.sessionMs}
						latencyHistory={conn.latencyHistory}
						keyboardLayout={settings.keyboardLayout}
						onOpenPerfPanel={() => setPerfOpen(true)}
						onSendCombo={sendCombo}
						onSendCtrlAltDel={() => sendCombo("Control+Alt+Delete")}
						onSettings={() => setSettingsOpen(true)}
						onPalette={() => setPaletteOpen(true)}
						onFullscreen={toggleFullscreen}
						onReconnect={handleReconnect}
						onDisconnect={handleDisconnect}
					/>
				</motion.div>

				{/* Top reveal strip — nudge the pointer to the top edge to bring
				    the auto-hidden bar back in fullscreen. */}
				{fullscreen && !chromeShown && (
					<div
						className="absolute inset-x-0 top-0 z-[69] h-2.5"
						onMouseEnter={revealChrome}
						aria-hidden
					/>
				)}

				<DesktopContextMenu
					connected={status === "connected"}
					onSendCombo={sendCombo}
					onFullscreen={toggleFullscreen}
					onSettings={() => setSettingsOpen(true)}
					onPalette={() => setPaletteOpen(true)}
					onReconnect={handleReconnect}
					onDisconnect={handleDisconnect}
				>
					<div className="desktop-stage relative flex-1 min-h-0 flex">
						<IronRemoteDesktopReact
							module={rdpModule}
							onReady={handleReady}
							onError={(err) => {
								conn.fail(ironErrorMessage(err))
							}}
							scale={mapScaleMode(settings.scaleMode)}
							flexcenter
							className="flex-1 min-h-0"
						/>
						<DesktopConnectionStage
							conn={conn}
							nodeName={nodeName}
							nodeHost={nodeHost}
							nodePort={nodePort}
							backendLabel="IronRDP"
							onRetry={handleReconnect}
							onRetryNow={handleReconnect}
							onForceTlsOnly={handleForceTlsOnly}
							onSwitchToGuacamole={handleSwitchToGuacamole}
							onDisconnect={handleDisconnect}
						/>
					</div>
				</DesktopContextMenu>

				<DesktopPerfPanel
					open={perfOpen}
					onOpenChange={setPerfOpen}
					sessionKey={nodeId}
					stats={stats}
					nodeName={nodeName}
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
			</PortalContainerProvider>
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
