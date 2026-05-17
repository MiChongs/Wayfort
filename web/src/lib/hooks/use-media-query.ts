"use client"

import * as React from "react"

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = React.useState(false)
  React.useEffect(() => {
    const mql = window.matchMedia(query)
    const apply = () => setMatch(mql.matches)
    apply()
    mql.addEventListener("change", apply)
    return () => mql.removeEventListener("change", apply)
  }, [query])
  return match
}
