"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/modules/identity/auth-client";
import { dict } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clearMustChangePasswordAction } from "./actions";

// Forced first-login password change (team/user-creation phase). Uses
// Better Auth's own core `changePassword` endpoint (NOT a custom hash/
// compare path) -- it independently re-verifies `currentPassword` server-
// side before accepting `newPassword`, so this form can never be used to
// take over an account without already knowing the admin-set password.
// On success, clears `mustChangePassword` (own session only, see
// actions.ts) and navigates to `next`.
export function ChangePasswordForm({ next }: { next: string }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError(dict.changePassword.tooShort);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(dict.changePassword.mismatch);
      return;
    }

    setPending(true);
    const { error: changeError } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });

    if (changeError) {
      setPending(false);
      setError(dict.changePassword.error);
      return;
    }

    await clearMustChangePasswordAction();
    setPending(false);
    setSuccess(true);
    router.push(next);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div>
        <Label htmlFor="currentPassword">{dict.changePassword.currentPasswordLabel}</Label>
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="newPassword">{dict.changePassword.newPasswordLabel}</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="confirmPassword">{dict.changePassword.confirmPasswordLabel}</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="text-sm text-muted-foreground">
          {dict.changePassword.success}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" loading={pending}>
        {pending ? dict.changePassword.submitting : dict.changePassword.submit}
      </Button>
    </form>
  );
}
