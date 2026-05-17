import { redirect } from "next/navigation"

export default function RootPage() {
  // The server-rendered page just sends the browser to /dashboard; the auth
  // guard on (app)/layout.tsx will bounce to /login if no token is present.
  redirect("/dashboard")
}
