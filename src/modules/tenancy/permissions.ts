import { ForbiddenError } from "@/platform/errors";
import type { Actor, MembershipRole } from "./types";

// ---------------------------------------------------------------------------
// Permission matrix -- server-side authz per operation (non-negotiable per
// CLAUDE.md / security.md §1). This is the CEILING on top of RLS's FLOOR:
// RLS only guarantees "this row belongs to a tenant I'm an active member
// of"; it does NOT know that a `cashier` must not delete an invoice or that
// only `owner`/`accountant` can edit tax settings. That per-role distinction
// lives here, and ONLY here -- never inferred from the client, never from a
// hidden/disabled button.
//
// Extended (2026-10-17, business-layer Phase 1 step 1) from the original
// 10-permission slice to the full set every business module (catalog,
// inventory, sales, billing, analytics, audit) needs. Fail-closed by
// construction: `MATRIX[role]` is a Set, and `assertCan` denies any
// permission not explicitly present for that role -- there is no
// wildcard/catch-all grant, even for `owner` (owner's set is spelled out in
// full below, not implied).
// ---------------------------------------------------------------------------

export type Permission =
  // --- pre-existing (tenancy/demo), unchanged ---
  | "settings:write" // structure display name, tax config, etc.
  | "member:invite"
  | "member:remove"
  // --- team / user-creation phase ---
  | "user:create" // admin-password-set account creation (owner/manager, see create-member.ts)
  | "member:scope_set" // assign/unassign a member's store (owner only -- see assign-member-warehouse.ts)
  // --- catalog ---
  | "product:read"
  | "product:write"
  | "product:archive"
  | "product:price_set"
  | "category:write"
  | "unit:write"
  | "warehouse:write"
  | "supplier:read"
  | "supplier:write"
  | "customer:read"
  | "customer:write"
  | "customer:delete"
  // --- inventory ---
  | "stock:read"
  | "stock:adjust"
  | "stock:receive"
  | "stock:oversell" // reserved to manager/owner (approved product decision)
  | "stock:rebuild" // recompute stock_levels projection from the ledger -- owner only
  // --- inter-store transfers (migration 0014 tables, this phase's use cases) ---
  | "transfer:read"
  | "transfer:create"
  | "transfer:receive"
  | "transfer:cancel"
  // --- physical stock counts (migration 0014 tables, this phase's use cases) ---
  | "count:open"
  | "count:validate"
  // --- supplier purchasing (migration 0015 tables) ---
  | "delivery:read"
  | "delivery:record"
  | "delivery:cancel"
  | "supplier_payment:record"
  | "supplier_payment:void"
  // --- rebates (migration 0016 tables) -- generic, quantity-driven, cliff-mode ---
  | "rebate:read"
  | "rebate:write" // create/edit a scale's tiers
  | "rebate:grant" // manual "vérifier le palier" trigger
  // --- sales ---
  | "sale:create"
  | "sale:read"
  | "sale:read_all"
  | "sale:void" // cancelling/crediting a confirmed sale -- sensitive (D3)
  | "sale:discount"
  | "sale:price_override"
  // --- billing ---
  | "invoice:read"
  | "invoice:read_all"
  | "invoice:issue"
  | "invoice:cancel"
  | "creditnote:issue"
  | "payment:read"
  | "payment:read_all"
  | "payment:record"
  | "payment:void"
  | "payment:allocate"
  | "cash:reconcile"
  | "tax:write"
  // --- analytics ---
  | "dashboard:read"
  | "dashboard:read_financials"
  | "report:export"
  | "treasury:read"
  // --- audit ---
  | "audit:read"
  | "audit:verify"
  | "audit:export";

// Every permission that exists, used below to grant `owner` the full set
// without hand-copying the list a second time (and without a wildcard that
// would silently include a permission added later without review).
const ALL_PERMISSIONS: readonly Permission[] = [
  "settings:write",
  "member:invite",
  "member:remove",
  "user:create",
  "member:scope_set",
  "product:read",
  "product:write",
  "product:archive",
  "product:price_set",
  "category:write",
  "unit:write",
  "warehouse:write",
  "supplier:read",
  "supplier:write",
  "customer:read",
  "customer:write",
  "customer:delete",
  "stock:read",
  "stock:adjust",
  "stock:receive",
  "stock:oversell",
  "stock:rebuild",
  "transfer:read",
  "transfer:create",
  "transfer:receive",
  "transfer:cancel",
  "count:open",
  "count:validate",
  "delivery:read",
  "delivery:record",
  "delivery:cancel",
  "supplier_payment:record",
  "supplier_payment:void",
  "rebate:read",
  "rebate:write",
  "rebate:grant",
  "sale:create",
  "sale:read",
  "sale:read_all",
  "sale:void",
  "sale:discount",
  "sale:price_override",
  "invoice:read",
  "invoice:read_all",
  "invoice:issue",
  "invoice:cancel",
  "creditnote:issue",
  "payment:read",
  "payment:read_all",
  "payment:record",
  "payment:void",
  "payment:allocate",
  "cash:reconcile",
  "tax:write",
  "dashboard:read",
  "dashboard:read_financials",
  "report:export",
  "treasury:read",
  "audit:read",
  "audit:verify",
  "audit:export",
];

const MATRIX: Record<MembershipRole, ReadonlySet<Permission>> = {
  // Owner: everything. Spelled out via ALL_PERMISSIONS (not a wildcard check
  // in `can()`) so a newly-added permission still requires a deliberate,
  // reviewable decision about who else gets it -- it does land on owner
  // automatically, which is the one role for which "gets every permission
  // that exists" is actually the intended default.
  owner: new Set<Permission>(ALL_PERMISSIONS),

  // Manager: nearly everything operational. Deliberately NOT given:
  // member:remove (unchanged from the pre-extension matrix -- removing a
  // teammate stays owner-only), customer:delete, stock:rebuild, audit:read/
  // verify/export (per the approved role matrix).
  manager: new Set<Permission>([
    "settings:write",
    "member:invite",
    // A manager may create teammate accounts (cashier/stock_keeper/etc. and
    // even a co-manager), but never an owner -- enforced in create-member.ts
    // (the use case's own role check), not here: the permission matrix only
    // answers "may this role call the use case at all".
    "user:create",
    // Deliberately NOT granted: member:remove (unchanged, owner-only) and
    // member:scope_set (store (re)assignment stays owner-only too -- see
    // assign-member-warehouse.ts, which already hard-codes this and now
    // also calls assertCan as defense in depth).
    "product:read",
    "product:write",
    "product:archive",
    "product:price_set",
    "category:write",
    "unit:write",
    "warehouse:write",
    "supplier:read",
    "supplier:write",
    "customer:read",
    "customer:write",
    "stock:read",
    "stock:adjust",
    "stock:receive",
    "stock:oversell",
    "transfer:read",
    "transfer:create",
    "transfer:receive",
    "transfer:cancel",
    "count:open",
    "count:validate",
    "delivery:read",
    "delivery:record",
    "delivery:cancel",
    // supplier_payment:record/void held by manager too (same tier as
    // payment:record/void above), but the USE CASE itself additionally
    // rejects a store-scoped manager ("gerant") via storeScopeFor -- supplier
    // debt is consolidated at tenant level by product decision, so a gerant
    // gets no "Payer" button even though the role-level permission is
    // granted (same ceiling-after-permission pattern as assertStoreAccess
    // elsewhere, just keyed off storeScopeFor !== null instead of a
    // mismatched warehouseId).
    "supplier_payment:record",
    "supplier_payment:void",
    "rebate:read",
    "rebate:write",
    "rebate:grant",
    "sale:create",
    "sale:read",
    "sale:read_all",
    "sale:void",
    "sale:discount",
    "sale:price_override",
    "invoice:read",
    "invoice:read_all",
    "invoice:issue",
    "invoice:cancel",
    "creditnote:issue",
    "payment:read",
    "payment:read_all",
    "payment:record",
    "payment:void",
    "payment:allocate",
    "cash:reconcile",
    "tax:write",
    "dashboard:read",
    "dashboard:read_financials",
    "report:export",
    "treasury:read",
  ]),

  // Cashier: the exact set from the approved plan. Note `sale:read` without
  // `sale:read_all` -- `scopeFor()` below is what turns that into "own
  // sales only" for a repository call, not a second permission check here.
  cashier: new Set<Permission>([
    "product:read",
    "stock:read",
    "customer:read",
    "customer:write",
    "sale:create",
    "sale:read",
    "invoice:read",
    "payment:read",
    "payment:record",
    "dashboard:read",
  ]),

  // Stock keeper: the stock/catalog operational set, no sales/money
  // permissions at all (not even `payment:read`), no `stock:oversell`
  // (reserved to manager/owner) and no `stock:rebuild` (owner only).
  // Judgment call: given `transfer:create`/`transfer:receive`/`count:open`/
  // `count:validate` (day-to-day stock operations, this role's whole
  // purpose) but NOT `transfer:cancel` -- reversing a transfer already
  // in transit is closer to the sensitive/reversal class of action
  // (D3-adjacent) and is reserved to manager/owner, same tier as
  // `stock:oversell`/`stock:rebuild` above. Flag for security-reviewer if
  // this split is judged too strict for a one-person-stockroom tenant.
  stock_keeper: new Set<Permission>([
    "product:read",
    "product:write",
    "category:write",
    "unit:write",
    "warehouse:write",
    "supplier:read",
    "supplier:write",
    "stock:read",
    "stock:adjust",
    "stock:receive",
    "transfer:read",
    "transfer:create",
    "transfer:receive",
    "count:open",
    "count:validate",
    // A stock keeper physically receives deliveries (same tier as
    // stock:receive/transfer:create above), but never records/voids a
    // supplier payment (money, not stock) and never touches a rebate scale.
    "delivery:read",
    "delivery:record",
  ]),

  // Accountant: the billing/receivables set + dashboard:read_financials +
  // audit:read, no sale:create. `product:read`/`customer:read`/
  // `sale:read_all` are a judgment call (flag for security-reviewer): an
  // accountant reconciling receivables needs to see which sale/product a
  // given invoice line belongs to, read-only, without being able to create
  // or touch a sale itself.
  accountant: new Set<Permission>([
    "product:read",
    "customer:read",
    "supplier:read",
    "sale:read_all",
    "delivery:read",
    "supplier_payment:record",
    "supplier_payment:void",
    "rebate:read",
    "rebate:grant",
    "invoice:read",
    "invoice:read_all",
    "invoice:issue",
    "invoice:cancel",
    "creditnote:issue",
    "payment:read",
    "payment:read_all",
    "payment:record",
    "payment:void",
    "payment:allocate",
    "cash:reconcile",
    "tax:write",
    "dashboard:read",
    "dashboard:read_financials",
    "report:export",
    "treasury:read",
    "audit:read",
  ]),

  // Auditor: read-only everywhere, including the audit chain itself.
  auditor: new Set<Permission>([
    "product:read",
    "supplier:read",
    "customer:read",
    "stock:read",
    "transfer:read",
    "delivery:read",
    "rebate:read",
    "sale:read_all",
    "invoice:read",
    "invoice:read_all",
    "payment:read",
    "payment:read_all",
    "dashboard:read",
    "dashboard:read_financials",
    "report:export",
    "treasury:read",
    "audit:read",
    "audit:verify",
    "audit:export",
  ]),
};

export function can(actor: Actor, permission: Permission): boolean {
  return MATRIX[actor.role]?.has(permission) ?? false;
}

// Throws ForbiddenError (fail-closed) rather than returning false, so a
// caller forgetting to check the return value can't accidentally proceed.
// Must be the FIRST line of a use case (application layer) -- never left to
// the route handler / Server Action wrapper, and never bypassed by an
// ad-hoc role check elsewhere.
export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    throw new ForbiddenError(
      `Role "${actor.role}" does not have permission "${permission}".`
    );
  }
}

// ---------------------------------------------------------------------------
// scopeFor -- turns a permission check into a REQUIRED repository parameter
// ("own" | "all"), so a cashier with `sale:read` but not `sale:read_all`
// only ever sees their own sales, enforced by the repository's type (scope
// is not optional there), not by remembering to filter in every call site.
//
// Two mechanisms, in order:
//  1. If the permission has a known broader "_all" sibling (today:
//     sale:read -> sale:read_all), scope is "all" only if the actor also
//     holds that sibling permission; otherwise "own".
//  2. Permissions with no "_all" sibling in the matrix (invoice:read,
//     payment:read -- the business plan scopes these to "own" for a cashier
//     even though there is no separate invoice:read_all permission) fall
//     back to a role-tier default. This is a deliberate judgment call (flag
//     for security-reviewer): if a future role needs a split finer than
//     "every role in FULL_VISIBILITY_ROLES sees everything, every other
//     role sees only its own", add an explicit "_all" permission and a
//     SCOPED_SIBLINGS entry instead of growing this fallback further.
// ---------------------------------------------------------------------------

export type Scope = "own" | "all";

const SCOPED_SIBLINGS: Partial<Record<Permission, Permission>> = {
  "sale:read": "sale:read_all",
  // M3 fix (security-reviewer, Medium): invoice/payment now have real
  // "_all" siblings instead of falling back to the generic role-tier
  // default -- see billing's listInvoices/listPayments/getInvoice for why
  // the generic fallback alone was never enough here (the OWN/ALL split
  // for these two is filtered by the linked SALE's created_by, not the
  // document's own created_by -- a different actor, the accountant who
  // issued it, for most invoices).
  "invoice:read": "invoice:read_all",
  "payment:read": "payment:read_all",
};

const FULL_VISIBILITY_ROLES: ReadonlySet<MembershipRole> = new Set<MembershipRole>([
  "owner",
  "manager",
  "accountant",
  "auditor",
]);

export function scopeFor(actor: Actor, permission: Permission): Scope {
  const sibling = SCOPED_SIBLINGS[permission];
  if (sibling) {
    return can(actor, sibling) ? "all" : "own";
  }
  return FULL_VISIBILITY_ROLES.has(actor.role) ? "all" : "own";
}

// ---------------------------------------------------------------------------
// Store scope (multi-store, migration 0014) -- a SEPARATE axis from
// `scopeFor('own'|'all')` above. `scopeFor` answers "which rows of MY OWN
// data (e.g. my own sales) can I see"; `storeScopeFor`/`assertStoreAccess`
// answer "which STORE(S) am I restricted to", independent of role-based
// data visibility. Deliberately not merged into one concept: an owner has
// `scopeFor(... ) === "all"` AND `storeScopeFor() === null` (every store),
// while a manager-as-gerant has `scopeFor(...) === "all"` (full data
// visibility among role-permitted permissions) but `storeScopeFor() !==
// null` (exactly one store) -- conflating the two would either leak a
// gerant's visibility across stores or wrongly restrict an owner.
//
// Mirrors `app_scoped_warehouse_id()` (0014, SECURITY DEFINER SQL helper):
// same source row (`memberships.warehouse_id`), same NULL-means-all-stores
// convention. This is the RLS FLOOR's app-layer twin, not a replacement for
// it -- every store-scoped repository call below is also re-checked by
// Postgres under RLS; this is the CEILING that turns a would-be cross-store
// read/write into a ForbiddenError (400-ish) instead of a silent empty
// result or a raw RLS denial (500-ish) the UI can't explain.
// ---------------------------------------------------------------------------

// Returns the actor's store scope: `null` = unrestricted (every store in
// the tenant, e.g. owner or any unscoped member), a warehouse id = pinned
// to exactly that one store (a "gerant").
export function storeScopeFor(actor: Actor): string | null {
  return actor.warehouseId;
}

// Throws ForbiddenError (fail-closed, same convention as assertCan) if the
// actor is store-scoped AND the target warehouseId is not their own store.
// An unscoped actor (storeScopeFor === null) always passes. Every
// `warehouseId` that arrives from the client -- a POS/stock store selector,
// a query string, a hidden form field -- MUST pass through this BEFORE it
// reaches a repository call, exactly like `assertCan` must run before a
// permission-gated write.
export function assertStoreAccess(actor: Actor, warehouseId: string): void {
  const scope = storeScopeFor(actor);
  if (scope !== null && scope !== warehouseId) {
    throw new ForbiddenError(
      `Actor is scoped to a single store and may not act on warehouse "${warehouseId}".`
    );
  }
}

// Combines the actor's OWN store scope with an OPTIONAL client-requested
// store filter (e.g. a store selector on the dashboard/stock screens) into
// the single `storeScope: string | null` every store-scoped repository
// port now requires -- the one place this merge logic lives, so every read
// use case (dashboard, stock, sales/payments listings) resolves it the same
// way instead of re-deriving it ad hoc:
//  - a store-scoped actor (gerant) ALWAYS gets their own store, full stop --
//    a requested id that differs is rejected via assertStoreAccess rather
//    than silently ignored (never let a forged selector value widen scope).
//  - an unscoped actor (owner, or any unscoped role) gets the requested
//    store if one was explicitly chosen, else `null` (every store) -- this
//    is what keeps a single-store tenant's screens exactly as simple as
//    before: no selector is ever rendered, so `requestedWarehouseId` stays
//    undefined and this just returns `null`.
export function resolveStoreScope(actor: Actor, requestedWarehouseId?: string | null): string | null {
  const ownScope = storeScopeFor(actor);
  if (ownScope !== null) {
    if (requestedWarehouseId && requestedWarehouseId !== ownScope) {
      assertStoreAccess(actor, requestedWarehouseId); // always throws here
    }
    return ownScope;
  }
  return requestedWarehouseId ?? null;
}
