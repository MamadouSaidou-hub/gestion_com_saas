// Shared, typed error classes for the authz/tenancy chain. Server Actions and
// Route Handlers catch these by `instanceof` to turn them into the right HTTP
// status / redirect, instead of leaking stack traces to the client.

export class UnauthenticatedError extends Error {
  constructor(message = "Not authenticated.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

// Thrown by resolveActor() when the authenticated user has no active
// membership in the requested structure -- NEVER thrown based on client-
// supplied role/structureId alone, always after a re-check against the
// `memberships` table for the session's real user id.
export class NotAMemberError extends Error {
  constructor(message = "You are not an active member of this structure.") {
    super(message);
    this.name = "NotAMemberError";
  }
}

// Thrown by assertCan() when the actor's role does not carry the required
// permission. Fail-closed: any permission not explicitly listed in the
// matrix for a role is denied.
export class ForbiddenError extends Error {
  constructor(message = "You are not allowed to perform this action.") {
    super(message);
    this.name = "ForbiddenError";
  }
}
