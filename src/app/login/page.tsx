import type { Metadata } from "next";
import { LoginForm } from "./login-form";
import { dict } from "@/lib/i18n";

// Public, unauthenticated page -- safe to index (unlike everything under
// /s/[structureId]/*, which is gated per performance.md's "SSR only pages
// authorized to be indexed" rule).
export const metadata: Metadata = {
  title: dict.login.title,
  robots: { index: true, follow: true },
};

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-base font-bold text-primary-foreground">
            G
          </div>
          <span className="text-sm font-medium text-muted-foreground">Gestion commerciale</span>
        </div>
        <h1 className="mb-4 text-xl font-semibold">{dict.login.title}</h1>
        <LoginForm />
      </div>
    </div>
  );
}
