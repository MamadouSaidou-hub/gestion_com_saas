import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_URL, MIGRATOR_URL } from "@/test/integration/db-constants";
import { seedStructure, addMembership, addWarehouse } from "@/test/integration/seed";
import type { Actor } from "@/modules/tenancy/types";

// ---------------------------------------------------------------------------
// Team / user-creation phase -- proves, against a real disposable Postgres
// container (not mocked), the acceptance criteria the coordinator's task
// names explicitly:
//   - creating a user creates both the auth account and the membership
//     atomically (a failure leaves neither).
//   - a manager cannot create an owner, nor reassign an owner's store.
//   - the last-owner guard surfaces as a clean error.
//   - a created user must change their password before anything else
//     (asserted here at the DB-flag level; the redirect itself is a thin
//     Next.js layout check, covered by reading the code, not re-testable
//     here without a browser).
// ---------------------------------------------------------------------------

process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let createMember: typeof import("./create-member").createMember;
let EmailAlreadyExistsErrorCtor: typeof import("./create-member").EmailAlreadyExistsError;
let CannotCreateOwnerErrorCtor: typeof import("./create-member").CannotCreateOwnerError;
let OwnerCannotBeStoreScopedErrorCtor: typeof import("./create-member").OwnerCannotBeStoreScopedError;
let changeMemberRole: typeof import("./change-member-role").changeMemberRole;
let CannotTargetOwnerRowErrorCtor: typeof import("./change-member-role").CannotTargetOwnerRowError;
let CannotPromoteToOwnerErrorCtor: typeof import("./change-member-role").CannotPromoteToOwnerError;
let LastOwnerGuardErrorCtor: typeof import("./change-member-role").LastOwnerGuardError;
let setMemberSuspended: typeof import("./suspend-member").setMemberSuspended;
let assignMemberWarehouse: typeof import("./assign-member-warehouse").assignMemberWarehouse;
let ForbiddenError: typeof import("@/platform/errors").ForbiddenError;

beforeAll(async () => {
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({
    createMember,
    EmailAlreadyExistsError: EmailAlreadyExistsErrorCtor,
    CannotCreateOwnerError: CannotCreateOwnerErrorCtor,
    OwnerCannotBeStoreScopedError: OwnerCannotBeStoreScopedErrorCtor,
  } = await import("./create-member"));
  ({
    changeMemberRole,
    CannotTargetOwnerRowError: CannotTargetOwnerRowErrorCtor,
    CannotPromoteToOwnerError: CannotPromoteToOwnerErrorCtor,
    LastOwnerGuardError: LastOwnerGuardErrorCtor,
  } = await import("./change-member-role"));
  ({ setMemberSuspended } = await import("./suspend-member"));
  ({ assignMemberWarehouse } = await import("./assign-member-warehouse"));
  ({ ForbiddenError } = await import("@/platform/errors"));
});

async function countIdentityRows(email: string): Promise<{ users: number; accounts: number }> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    const users = await sql`select id from "user" where email = ${email}`;
    if (users.length === 0) {
      return { users: 0, accounts: 0 };
    }
    const accounts = await sql`select id from "account" where user_id = ${users[0].id}`;
    return { users: users.length, accounts: accounts.length };
  } finally {
    await sql.end();
  }
}

async function countMembership(structureId: string, userId: string): Promise<number> {
  const sql = postgres(MIGRATOR_URL, { max: 1 });
  try {
    const rows = await sql`
      select 1 from memberships where structure_id = ${structureId} and user_id = ${userId}
    `;
    return rows.length;
  } finally {
    await sql.end();
  }
}

describe("createMember: one-transaction atomicity", () => {
  it("creates the identity user, the credential account, and the membership together", async () => {
    const fixture = await seedStructure();
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const email = `cashier-${Date.now()}@example.test`;

    const created = await withTenantSession(owner, (ctx) =>
      createMember(ctx, { name: "Caissiere Test", email, password: "correct-horse-1", role: "cashier" })
    );

    const { users, accounts } = await countIdentityRows(email);
    expect(users).toBe(1);
    expect(accounts).toBe(1);
    const membershipCount = await countMembership(fixture.structureId, created.userId);
    expect(membershipCount).toBe(1);
  });

  it("a bad warehouseId fails BEFORE any write -- no orphaned user/account", async () => {
    const fixture = await seedStructure();
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const email = `badwarehouse-${Date.now()}@example.test`;

    await expect(
      withTenantSession(owner, (ctx) =>
        createMember(ctx, {
          name: "Should Not Exist",
          email,
          password: "correct-horse-1",
          role: "cashier",
          warehouseId: "00000000-0000-0000-0000-000000000000",
        })
      )
    ).rejects.toThrow();

    const { users, accounts } = await countIdentityRows(email);
    expect(users).toBe(0);
    expect(accounts).toBe(0);
  });

  it("two concurrent createMember calls for the SAME email: exactly one wins, the loser's transaction rolls back the identity insert too (true one-transaction atomicity, not just a pre-check)", async () => {
    const fixture = await seedStructure();
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const email = `race-${Date.now()}@example.test`;

    const attempt = () =>
      withTenantSession(owner, (ctx) =>
        createMember(ctx, { name: "Racer", email, password: "correct-horse-1", role: "cashier" })
      );

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser's own "user" INSERT hit the unique email index mid-
    // transaction (not a pre-check this test control for) -- its WHOLE
    // transaction (user + account + membership) rolled back, so exactly
    // ONE user/account/membership triple exists for this email, never two
    // and never a dangling user with no membership.
    const { users, accounts } = await countIdentityRows(email);
    expect(users).toBe(1);
    expect(accounts).toBe(1);
  });

  it("rejects a duplicate email without creating a second user/account", async () => {
    const fixture = await seedStructure();
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const email = `dup-${Date.now()}@example.test`;

    await withTenantSession(owner, (ctx) =>
      createMember(ctx, { name: "First", email, password: "correct-horse-1", role: "cashier" })
    );

    await expect(
      withTenantSession(owner, (ctx) =>
        createMember(ctx, { name: "Second", email, password: "correct-horse-2", role: "stock_keeper" })
      )
    ).rejects.toThrow(EmailAlreadyExistsErrorCtor);

    const { users, accounts } = await countIdentityRows(email);
    expect(users).toBe(1);
    expect(accounts).toBe(1);
  });

  it("the created user's mustChangePassword flag is set (forced change on first login)", async () => {
    const fixture = await seedStructure();
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const email = `forcechange-${Date.now()}@example.test`;

    await withTenantSession(owner, (ctx) =>
      createMember(ctx, { name: "Must Change", email, password: "correct-horse-1", role: "cashier" })
    );

    const sql = postgres(MIGRATOR_URL, { max: 1 });
    try {
      const [row] = await sql`select must_change_password from "user" where email = ${email}`;
      expect(row.must_change_password).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("a manager cannot create an owner", async () => {
    const fixture = await seedStructure();
    const managerUserId = await addMembership(fixture, "manager");
    const manager: Actor = { userId: managerUserId, structureId: fixture.structureId, role: "manager", warehouseId: null };
    const email = `bad-owner-${Date.now()}@example.test`;

    await expect(
      withTenantSession(manager, (ctx) =>
        createMember(ctx, { name: "Sneaky Owner", email, password: "correct-horse-1", role: "owner" })
      )
    ).rejects.toThrow(CannotCreateOwnerErrorCtor);

    const { users } = await countIdentityRows(email);
    expect(users).toBe(0);
  });

  it("an owner can never be created store-scoped", async () => {
    const fixture = await seedStructure();
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };
    const email = `owner-store-${Date.now()}@example.test`;

    await expect(
      withTenantSession(owner, (ctx) =>
        createMember(ctx, {
          name: "Co Owner",
          email,
          password: "correct-horse-1",
          role: "owner",
          warehouseId: fixture.warehouseId,
        })
      )
    ).rejects.toThrow(OwnerCannotBeStoreScopedErrorCtor);
  });

  it("a cashier cannot create a user at all (lacks user:create)", async () => {
    const fixture = await seedStructure();
    const cashierUserId = await addMembership(fixture, "cashier");
    const cashier: Actor = { userId: cashierUserId, structureId: fixture.structureId, role: "cashier", warehouseId: null };
    const email = `forbidden-${Date.now()}@example.test`;

    await expect(
      withTenantSession(cashier, (ctx) =>
        createMember(ctx, { name: "Nope", email, password: "correct-horse-1", role: "cashier" })
      )
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("changeMemberRole: owner/last-owner guard rails", () => {
  it("a manager cannot touch an owner's row (demote/role-change)", async () => {
    const fixture = await seedStructure();
    const managerUserId = await addMembership(fixture, "manager");
    const manager: Actor = { userId: managerUserId, structureId: fixture.structureId, role: "manager", warehouseId: null };

    await expect(
      withTenantSession(manager, (ctx) =>
        changeMemberRole(ctx, { memberUserId: fixture.ownerUserId, newRole: "cashier" })
      )
    ).rejects.toThrow(CannotTargetOwnerRowErrorCtor);
  });

  it("a manager cannot promote anyone to owner", async () => {
    const fixture = await seedStructure();
    const managerUserId = await addMembership(fixture, "manager");
    const cashierUserId = await addMembership(fixture, "cashier");
    const manager: Actor = { userId: managerUserId, structureId: fixture.structureId, role: "manager", warehouseId: null };

    await expect(
      withTenantSession(manager, (ctx) => changeMemberRole(ctx, { memberUserId: cashierUserId, newRole: "owner" }))
    ).rejects.toThrow(CannotPromoteToOwnerErrorCtor);
  });

  it("changeMemberRole blocks self-targeting BEFORE the DB trigger is ever reached (the sole owner can't demote themselves)", async () => {
    // Documents a real finding: with exactly one owner, the ONLY row that
    // could ever trip the DB's owner-lockout trigger (0003) via
    // changeMemberRole is the actor's OWN row -- and
    // changeMemberRole/setMemberSuspended both already refuse to touch the
    // caller's own row (CannotChangeOwnRoleError/CannotSuspendSelfError),
    // same as the RLS floor itself (memberships_update's `user_id <>
    // app_current_user_id()`). So LastOwnerGuardError can never actually
    // surface through either use case in practice -- confirmed by
    // execution (this assertion), not assumed. See the next test for a
    // direct proof that the underlying trigger + our error-message match
    // still work, for the day a future caller reaches it some other way.
    const fixture = await seedStructure();
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };

    await expect(
      withTenantSession(owner, (ctx) => changeMemberRole(ctx, { memberUserId: fixture.ownerUserId, newRole: "manager" }))
    ).rejects.toThrow("cannot change your own role");
  });

  it("the DB's owner-lockout trigger fires with the exact message changeMemberRole's catch block matches on", async () => {
    // Bypasses BOTH changeMemberRole AND the RLS floor (migrator role,
    // BYPASSRLS -- same convention as seed.ts) to reach the trigger
    // directly: self-targeting is blocked even EARLIER than the app-layer
    // check above by RLS itself (memberships_update's `user_id <>
    // app_current_user_id()` silently excludes the row from an UPDATE,
    // no error -- confirmed by execution, see db/README.md's "RLS -- the
    // floor" section). This is the only way left to prove the trigger +
    // the exact message format changeMemberRole's/setMemberSuspended's
    // catch blocks match on are still real, for the day some future,
    // differently-shaped caller reaches it.
    const fixture = await seedStructure();
    const sql = postgres(MIGRATOR_URL, { max: 1 });
    try {
      await expect(
        sql`update memberships set role = 'manager' where structure_id = ${fixture.structureId} and user_id = ${fixture.ownerUserId}`
      ).rejects.toThrow(/cannot remove\/demote the last active owner/);
    } finally {
      await sql.end();
    }
  });

  it("an owner CAN demote a second owner as long as one remains", async () => {
    const fixture = await seedStructure();
    const secondOwnerUserId = await addMembership(fixture, "owner");
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };

    await withTenantSession(owner, (ctx) => changeMemberRole(ctx, { memberUserId: secondOwnerUserId, newRole: "manager" }));

    const sql = postgres(MIGRATOR_URL, { max: 1 });
    try {
      const [row] = await sql`
        select role from memberships where structure_id = ${fixture.structureId} and user_id = ${secondOwnerUserId}
      `;
      expect(row.role).toBe("manager");
    } finally {
      await sql.end();
    }
  });
});

describe("suspend/reassign guard rails", () => {
  it("the last active owner cannot be suspended", async () => {
    const fixture = await seedStructure();
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner", warehouseId: null };

    await expect(
      withTenantSession(owner, (ctx) => setMemberSuspended(ctx, { memberUserId: fixture.ownerUserId, suspended: true }))
    ).rejects.toThrow();
  });

  it("a manager cannot reassign an owner's store (owner can never be store-scoped)", async () => {
    const fixture = await seedStructure();
    const managerUserId = await addMembership(fixture, "manager");
    const secondWarehouseId = await addWarehouse(fixture, { code: "B2", name: "Succursale B2" });
    const manager: Actor = { userId: managerUserId, structureId: fixture.structureId, role: "manager", warehouseId: null };

    // Gated by member:scope_set (owner-only) before even reaching the
    // owner-row check -- a manager is rejected at the permission ceiling.
    await expect(
      withTenantSession(manager, (ctx) =>
        assignMemberWarehouse(ctx, { memberUserId: fixture.ownerUserId, warehouseId: secondWarehouseId })
      )
    ).rejects.toThrow(ForbiddenError);
  });
});
