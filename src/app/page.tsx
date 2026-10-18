import { redirect } from "next/navigation";

// The root path has no public content to index/serve -- redirect to the
// login page. Everything beyond login is tenant-scoped and gated server-
// side (resolveActor), never trusted from a client-side route alone.
export default function RootPage() {
  redirect("/login");
}
