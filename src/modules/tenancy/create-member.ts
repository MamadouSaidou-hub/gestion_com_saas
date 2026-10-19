import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { memberships } from "@/db/schema/tenancy";
import { warehouses } from "@/db/schema/catalog";
import { user as identityUser, account as identityAccount } from "@/modules/identity/schema";
import { assertCan } from "./permissions";
import { ForbiddenError } from "@/platform/errors";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { MembershipRole } from "./types";

// ---------------------------------------------------------------------------
// createMember -- "créer un utilisateur" on /parametres/equipe.
//
// Decision taken (per the coordinator's instruction, documented here for
// security-reviewer): the admin (owner/manager) picks the new teammate's
// password; the teammate is forced to change it on first login
// (mustChangePassword, identity schema.ts/migration 0002). An invitation
// link is the safer pattern and the `invitations` table is already built
// and hardened (see db/README.md's long invitations fix-round history) --
// but D5 (CLAUDE.md) has no email/SMS provider wired, so an invitation
// nobody can deliver is useless today. Revisit once D5 lands.
//
// TWO TRAPS, both respected here:
//   1. NEVER call auth.api.signUpEmail server-side -- it mints a session
//      and writes a Set-Cookie for the CALLING request, i.e. the owner/
//      manager's own browser gets logged in as the brand-new teammate.
//   2. Better Auth's own `role` field is NOT our authority -- `memberships
//      .role` is the only thing any permission check in this codebase ever
//      reads. We go further than "don't let them drift": this project does
//      not even install Better Auth's admin plugin (the thing that adds a
//      `role` column to `user` in the first place), so there is no second
//      role field to drift from ours at all.
//
// JUDGMENT CALL (flag for security-reviewer): the task names
// `auth.api.createUser` (admin plugin) as the mechanism, specifically
// because it's the one Better Auth API that creates a user WITHOUT the
// signUpEmail session side-effect. We deviate from calling that endpoint
// specifically, for a reason the task's OWN acceptance tests require:
// `auth.api.createUser` runs its own request against the raw `db` client
// from src/db/index.ts -- a DIFFERENT Postgres transaction than the
// `memberships` INSERT below (which runs inside withTenantSession's tx).
// Two separate transactions cannot be made atomic from application code
// without a distributed/2PC protocol this stack doesn't have, which fails
// the explicit requirement ("in one transaction... a failure leaves
// neither") and the integration test that proves it. Instead, we inline
// EXACTLY what createUser's endpoint does under the hood (confirmed by
// reading better-auth@1.2.x's admin plugin source):
//   - insert into "user" (same columns, including our mustChangePassword
//     additionalField)
//   - hash the password with Better Auth's OWN exported hashPassword()
//     (better-auth/crypto -- the exact function the emailAndPassword
//     provider's login path verifies against, since auth.ts does not
//     override `emailAndPassword.password`)
//   - insert into "account" with providerId "credential", accountId =
//     user.id (same shape createUser's endpoint produces)
// ...using `ctx.db` -- the SAME withTenantSession transaction as the
// membership INSERT and the audit append. This is the only way to get the
// true one-transaction atomicity the task asks for and tests, while still
// avoiding signUpEmail's session side-effect entirely (we never call any
// session-creating Better Auth endpoint). No Better Auth request/response
// cycle (and therefore no cookie) is ever touched by this function.
// ---------------------------------------------------------------------------

export class EmailAlreadyExistsError extends Error {
  constructor(email: string) {
    super(`A user with email "${email}" already exists.`);
    this.name = "EmailAlreadyExistsError";
  }
}

export class CannotCreateOwnerError extends Error {
  constructor() {
    super('Only an "owner" may create another "owner".');
    this.name = "CannotCreateOwnerError";
  }
}

export class OwnerCannotBeStoreScopedError extends Error {
  constructor() {
    super('An "owner" membership can never be scoped to a single store.');
    this.name = "OwnerCannotBeStoreScopedError";
  }
}

export class WarehouseNotFoundError extends Error {
  constructor(warehouseId: string) {
    super(`Warehouse "${warehouseId}" was not found in this structure.`);
    this.name = "WarehouseNotFoundError";
  }
}

const inputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(8).max(200),
  role: z.enum(["owner", "manager", "cashier", "stock_keeper", "accountant", "auditor"]),
  warehouseId: z.uuid().nullable().optional(),
});

export interface CreateMemberInput {
  name: string;
  email: string;
  password: string;
  role: MembershipRole;
  warehouseId?: string | null;
}

export interface CreatedMember {
  userId: string;
  name: string;
  email: string;
  role: MembershipRole;
  warehouseId: string | null;
}

export async function createMember(
  ctx: TenantSessionContext,
  rawInput: CreateMemberInput
): Promise<CreatedMember> {
  // assertCan FIRST (convention) -- gates "may this role create accounts at
  // all" (owner/manager). The owner-only "may NOT create another owner"
  // rule is a finer-grained check below, same pattern as
  // assign-member-warehouse.ts's owner-only store-scoping rule.
  assertCan(ctx.actor, "user:create");

  const input = inputSchema.parse(rawInput);
  const warehouseId = input.warehouseId ?? null;

  if (input.role === "owner" && ctx.actor.role !== "owner") {
    throw new CannotCreateOwnerError();
  }
  if (input.role === "owner" && warehouseId !== null) {
    throw new OwnerCannotBeStoreScopedError();
  }

  if (warehouseId !== null) {
    const [warehouse] = await ctx.db
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(and(eq(warehouses.structureId, ctx.actor.structureId), eq(warehouses.id, warehouseId)))
      .limit(1);
    if (!warehouse) {
      throw new WarehouseNotFoundError(warehouseId);
    }
  }

  const [existing] = await ctx.db
    .select({ id: identityUser.id })
    .from(identityUser)
    .where(eq(identityUser.email, input.email))
    .limit(1);
  if (existing) {
    throw new EmailAlreadyExistsError(input.email);
  }

  const now = new Date();
  const userId = randomUUID();
  const hashed = await hashPassword(input.password);

  // All three writes below + the audit append run inside the SAME
  // Postgres transaction withTenantSession already opened (ctx.db === that
  // transaction's tx object) -- see this file's header comment for why
  // this inlines createUser's persistence shape instead of calling it.
  await ctx.db.insert(identityUser).values({
    id: userId,
    name: input.name,
    email: input.email,
    emailVerified: false,
    mustChangePassword: true,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert(identityAccount).values({
    id: randomUUID(),
    accountId: userId,
    providerId: "credential",
    userId,
    password: hashed,
    createdAt: now,
    updatedAt: now,
  });

  // memberships_insert's RLS policy (0006, H-F fix) independently re-checks
  // the "non-owner cannot insert an owner row" rule we already checked
  // above -- defense in depth, not redundant dead code: if this app-layer
  // check is ever loosened by mistake, the DB floor still holds.
  await ctx.db.insert(memberships).values({
    userId,
    structureId: ctx.actor.structureId,
    role: input.role,
    status: "active",
    warehouseId,
  });

  await ctx.audit.append({
    action: "member.created",
    targetType: "membership",
    targetId: userId,
    // ids and amounts only -- no email/name here (audit_log is append-only
    // and can never be edited/deleted, see audit-writer.ts's PII guard).
    payload: { role: input.role, warehouseId },
  });

  return { userId, name: input.name, email: input.email, role: input.role, warehouseId };
}
