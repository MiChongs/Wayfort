// InputBridge — sets up the hidden, event-receiving Guacamole element so
// Mouse/Keyboard/Touch from guacamole-common-js can attach to it. The Pixi
// canvas sits above visually (pointer-events:none) and the Guac element
// sits below (or in the same layer) with pointer-events:auto + opacity:0.
//
// Coordinates: Viewport applies the same CSS transform to this element as
// the Pixi stage transform, so Guacamole.Mouse's getBoundingClientRect
// math naturally yields remote-pixel coordinates without manual conversion.

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
    // We host Guacamole's display element here so its internal canvas keeps
    // receiving paints, but the wrapper has opacity:0 so Pixi above is what
    // the user sees.
    const wrapper = document.createElement("div")
    wrapper.dataset.guacInputWrapper = "1"
    wrapper.style.position = "absolute"
    wrapper.style.top = "0"
    wrapper.style.left = "0"
    wrapper.style.opacity = "0"
    // Critical: receive mouse / touch events so Guacamole.Mouse fires.
    wrapper.style.pointerEvents = "auto"
    // Don't let the user accidentally select the invisible canvas content.
    wrapper.style.userSelect = "none"
    // Default intrinsic size; Viewport.setRemoteSize() updates these.
    wrapper.style.width = "1280px"
    wrapper.style.height = "720px"
    wrapper.style.transformOrigin = "0 0"
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
