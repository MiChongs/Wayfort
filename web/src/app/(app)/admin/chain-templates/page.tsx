import { redirect } from "next/navigation"

// Absorbed into the unified 代理链中心 (/admin/proxy-center). Kept as a redirect
// so existing deep links / bookmarks still land on the templates tab.
export default function ChainTemplatesPage() {
  redirect("/admin/proxy-center?tab=templates")
}
