// InputBridge — mounts the Guacamole display element into the host so it
// receives mouse / keyboard / touch events AND renders the visible
// desktop (Plan 16 architecture flip). Guacamole's display is now the
// primary user-visible surface; Pixi sits on top as a transparent overlay
// for annotation strokes only.
//
// Coordinates: Guacamole.Display.scale(s) propagates the scale internally
// to every child canvas (background + cursor + buffers) and adjusts mouse
// coords accordingly. We don't apply CSS transforms here.

// We intentionally type the constructor returns as `unknown` so this module
// composes with the broader GuacNS type in client.ts without duplicating
// the type tree. We narrow on assignment via inline interfaces.
export interface GuacInputCtors {
  Mouse: new (el: HTMLElement) => unknown
  Keyboard: new (target: Document | HTMLElement) => unknown
  Touch?: new (el: HTMLElement) => unknown
}

interface GuacMouseLike {
  onmousedown?: (s: unknown) => void
  onmouseup?: (s: unknown) => void
  onmousemove?: (s: unknown) => void
}
interface GuacKeyboardLike {
  onkeydown?: (k: number) => void
  onkeyup?: (k: number) => void
}
interface GuacTouchLike {
  onmousedown?: (s: unknown) => void
  onmouseup?: (s: unknown) => void
  onmousemove?: (s: unknown) => void
}

interface SendableClient {
  sendMouseState(state: unknown): void
  sendKeyEvent(pressed: number, keysym: number): void
}

export interface InputBridgeOptions {
  host: HTMLElement
  guacDisplayElement: HTMLElement
  ctors: GuacInputCtors
  client: SendableClient
}

export class InputBridge {
  private inputEl: HTMLElement
  // Kept for the destroy path so we can detach listeners. The library
  // doesn't expose a destroy() method on Mouse/Keyboard, but their event
  // listeners are scoped to the elements we hand them, so removing the
  // elements unwires them.
  private guacWrapper: HTMLElement | null = null

  constructor(private opts: InputBridgeOptions) {
    this.inputEl = this.mountHiddenSurface()
    this.bindInputs()
  }

  // The DOM element Viewport applies CSS transform to. Same element the
  // Guacamole input ctors are attached to.
  getInputElement(): HTMLElement {
    return this.inputEl
  }

  destroy(): void {
    if (this.guacWrapper && this.guacWrapper.parentElement) {
      this.guacWrapper.parentElement.removeChild(this.guacWrapper)
    }
    this.guacWrapper = null
  }

  private mountHiddenSurface(): HTMLElement {
    // Plan 16: Guacamole's display element IS the visible desktop surface
    // now. We host it inside a centered wrapper so the rendered canvases
    // (whose intrinsic size is the remote desktop pixels) get positioned
    // relative to the host. Viewport.setMode() calls Guacamole.Display.scale()
    // which CSS-transforms the display down to fit; the wrapper provides
    // the flex centering.
    const wrapper = document.createElement("div")
    wrapper.dataset.guacInputWrapper = "1"
    wrapper.style.position = "absolute"
    wrapper.style.inset = "0"
    wrapper.style.display = "flex"
    wrapper.style.alignItems = "center"
    wrapper.style.justifyContent = "center"
    wrapper.style.overflow = "hidden"
    // Receive mouse / touch events so Guacamole.Mouse fires.
    wrapper.style.pointerEvents = "auto"
    wrapper.style.userSelect = "none"
    wrapper.style.touchAction = "none"
    wrapper.appendChild(this.opts.guacDisplayElement)
    this.opts.host.appendChild(wrapper)
    this.guacWrapper = wrapper
    return wrapper
  }

  private bindInputs(): void {
    const { ctors, client } = this.opts
    const mouse = new ctors.Mouse(this.inputEl) as GuacMouseLike
    mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state: unknown) =>
      client.sendMouseState(state)
    const keyboard = new ctors.Keyboard(document) as GuacKeyboardLike
    keyboard.onkeydown = (key: number) => client.sendKeyEvent(1, key)
    keyboard.onkeyup = (key: number) => client.sendKeyEvent(0, key)
    if (typeof ctors.Touch === "function") {
      const touch = new ctors.Touch(this.inputEl) as GuacTouchLike
      touch.onmousedown = touch.onmouseup = touch.onmousemove = (state: unknown) =>
        client.sendMouseState(state)
    }
  }
}
