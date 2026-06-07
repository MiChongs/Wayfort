"use client"

import * as React from "react"

// PortalContainer lets a subtree redirect every shadcn overlay's portal into a
// specific element instead of document.body. Radix portals default to body,
// which the native Fullscreen API renders invisible — so settings sheets, menus,
// tooltips and dialogs vanish once a viewer goes fullscreen. Wrap the fullscreen
// element's subtree in <PortalContainerProvider value={fullscreenEl}> and every
// nested overlay renders inside it. No provider (or null) → undefined →
// radix's default (document.body), so all other call-sites are unaffected.
const PortalContainerContext = React.createContext<Element | null | undefined>(undefined)

export function PortalContainerProvider({
  value,
  children,
}: {
  value: Element | null | undefined
  children: React.ReactNode
}) {
  return <PortalContainerContext.Provider value={value}>{children}</PortalContainerContext.Provider>
}

// usePortalContainer returns the active container, or undefined for the default
// body target. Pass it straight to a radix `*.Portal`'s `container` prop.
export function usePortalContainer(): Element | undefined {
  const value = React.useContext(PortalContainerContext)
  return value ?? undefined
}
