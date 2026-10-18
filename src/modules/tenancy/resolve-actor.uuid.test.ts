import { describe, expect, it } from "vitest";
import { resolveActor } from "./resolve-actor";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";

// M8 (security-reviewer finding): a malformed structureId from the URL must
// fail the SAME way a real non-member does (NotAMemberError), never an
// unhandled Postgres cast error. This test only exercises the validation
// branch (it never reaches the DB transaction for a malformed id), so it
// needs no DB connection.
describe("resolveActor UUID validation (M8)", () => {
  it("throws NotAMemberError (not a 500) for a non-UUID structureId", async () => {
    await expect(
      resolveActor({ user: { id: "user_1" } }, "not-a-uuid")
    ).rejects.toThrow(NotAMemberError);
  });

  it("throws NotAMemberError for a path-traversal-looking structureId", async () => {
    await expect(
      resolveActor({ user: { id: "user_1" } }, "../../etc/passwd")
    ).rejects.toThrow(NotAMemberError);
  });

  it("still throws UnauthenticatedError when there is no session, before UUID validation", async () => {
    await expect(resolveActor(null, "not-a-uuid")).rejects.toThrow(UnauthenticatedError);
  });
});
