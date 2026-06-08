// Public route group — pages reachable with no login at all. The root
// Providers (theme / react-query / i18n / sonner) already wrap this, so the
// layout itself just claims the full viewport and stays out of the way. No
// auth guard: that's the whole point of the anonymous sandbox.
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-full w-full overflow-hidden bg-background text-foreground">{children}</div>
}
