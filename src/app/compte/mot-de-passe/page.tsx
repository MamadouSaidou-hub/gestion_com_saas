import { redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { dict } from "@/lib/i18n";
import { ChangePasswordForm } from "./change-password-form";

// Forced first-login password change (team/user-creation phase). Reached
// only via redirectIfMustChangePassword() (/s, /s/[structureId]/layout.tsx)
// -- a user who does NOT need to change their password is bounced straight
// back to /s, so this is never a dead end/orphan screen reachable with
// nothing to do. `next` is validated to be a same-origin relative path
// only (never an open redirect): it must start with "/" and never "//".
export const dynamic = "force-dynamic";

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const { next: rawNext } = await searchParams;
  const next = rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/s";

  if (!session.user.mustChangePassword) {
    redirect(next);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-xl font-semibold">{dict.changePassword.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{dict.changePassword.subtitle}</p>
        </div>
        <ChangePasswordForm next={next} />
      </div>
    </div>
  );
}
