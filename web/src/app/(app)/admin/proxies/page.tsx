import { redirect } from "next/navigation"

// Absorbed into the unified 代理链中心 (/admin/proxy-center). Kept as a redirect
// so existing deep links / bookmarks still land on the catalog.
export default function ProxiesPage() {
  redirect("/admin/proxy-center?tab=catalog")
}
