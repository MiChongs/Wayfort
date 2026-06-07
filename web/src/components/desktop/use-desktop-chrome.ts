"use client"

import * as React from "react"

// useDesktopChrome drives the single auto-hiding control bar shared by both
// desktop viewers (FreeRDP + IronRDP).
//
// - In fullscreen the bar overlays the canvas and slides away after a short
//   idle, revealing on pointer movement (or at the top edge), like a video
//   player. In windowed mode it stays pinned.
// - It never hides while an overlay (settings / files / palette / perf) is open
//   or the pointer hovers the bar.
// - `setWrap` is a callback ref that mirrors the wrapper element into both a ref
//   (for the Fullscreen API) and state, so overlays can portal INTO the
//   fullscreen element via PortalContainerProvider — radix defaults to
//   document.body, which the native Fullscreen API renders invisible.
export function useDesktopChrome(fullscreen: boolean, anyOverlayOpen: boolean) {
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const [wrapEl, setWrapEl] = React.useState<HTMLDivElement | null>(null)
  const setWrap = React.useCallback((el: HTMLDivElement | null) => {
    wrapRef.current = el
    setWrapEl(el)
  }, [])

  const [chromeShown, setChromeShown] = React.useState(true)
  const chromeShownRef = React.useRef(true)
  const chromeHovered = React.useRef(false)
  const hideTimer = React.useRef<number | undefined>(undefined)
  const fullscreenRef = React.useRef(false)
  const overlayOpenRef = React.useRef(false)

  React.useEffect(() => {
    fullscreenRef.current = fullscreen
  }, [fullscreen])
  React.useEffect(() => {
    overlayOpenRef.current = anyOverlayOpen
  }, [anyOverlayOpen])

  const setChrome = React.useCallback((v: boolean) => {
    chromeShownRef.current = v
    setChromeShown(v)
  }, [])

  const scheduleHide = React.useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    if (!fullscreenRef.current || chromeHovered.current || overlayOpenRef.current) return
    hideTimer.current = window.setTimeout(() => setChrome(false), 2600)
  }, [setChrome])

  const revealChrome = React.useCallback(() => {
    if (!chromeShownRef.current) setChrome(true)
    scheduleHide()
  }, [setChrome, scheduleHide])

  // Reveal + arm the idle timer on fullscreen enter; pin the bar on exit.
  React.useEffect(() => {
    if (fullscreen) {
      setChrome(true)
      scheduleHide()
    } else {
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
      setChrome(true)
    }
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    }
  }, [fullscreen, setChrome, scheduleHide])

  // Force-show while any overlay is open; re-arm the idle hide once they close.
  React.useEffect(() => {
    if (anyOverlayOpen) {
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
      setChrome(true)
    } else {
      scheduleHide()
    }
  }, [anyOverlayOpen, setChrome, scheduleHide])

  const onBarMouseEnter = React.useCallback(() => {
    chromeHovered.current = true
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
  }, [])
  const onBarMouseLeave = React.useCallback(() => {
    chromeHovered.current = false
    scheduleHide()
  }, [scheduleHide])

  return {
    wrapRef,
    wrapEl,
    setWrap,
    chromeShown,
    revealChrome,
    scheduleHide,
    onBarMouseEnter,
    onBarMouseLeave,
  }
}
