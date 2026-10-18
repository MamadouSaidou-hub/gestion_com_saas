import type { Actor } from "./types";

// ---------------------------------------------------------------------------
// Step-up / re-authentication seam (D5 / D3 interim control).
//
// No OTP provider is wired yet (CLAUDE.md D5 -- the WhatsApp-primary/SMS-
// aggregator fallback still needs to be picked and sandbox-validated). Until
// then, the interim control for an action that needs step-up (e.g. a
// discount above a structure's configurable separation-of-duties threshold,
// once `structure_settings.sod_threshold_minor` is enabled for a structure)
// is a fresh password re-authentication through Better Auth, not a one-time
// code.
//
// This function is deliberately just the seam: every call site that will
// eventually require OTP already calls `requireStepUp(actor, reason)` from
// day one, so swapping the implementation for a real challenge later is a
// one-line change in THIS file, not a hunt through every use case that
// calls it.
//
// It throws unconditionally today -- no use case in this phase calls it yet
// (separation of duties is disabled by default per the approved plan, and
// no caller should silently treat an unimplemented step-up as "approved").
// Wire the real challenge (password re-auth via Better Auth, then OTP later)
// before any call site that needs this actually ships.
// ---------------------------------------------------------------------------

export class StepUpNotImplementedError extends Error {
  constructor(reason: string) {
    super(
      `Step-up re-authentication is required for "${reason}" but no step-up ` +
        `provider is wired yet (interim control: password re-auth via Better ` +
        `Auth -- see this file's header comment). Do not remove this call ` +
        `site to work around the error; wire the real challenge instead.`
    );
    this.name = "StepUpNotImplementedError";
  }
}

export async function requireStepUp(actor: Actor, reason: string): Promise<void> {
  // `actor` is accepted now (not just `reason`) so the eventual real
  // implementation -- which needs the actor's user id to challenge the
  // right account -- is a body-only change, not a signature change at every
  // call site.
  void actor;
  throw new StepUpNotImplementedError(reason);
}
