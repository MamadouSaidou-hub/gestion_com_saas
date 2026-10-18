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
  | "stock:transfer"
  | "stock:count"
  | "stock:oversell" // reserved to manager/owner (approved product decision)
  | "stock:rebuild" // recompute stock_levels projection from the ledger -- owner only
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
  "stock:transfer",
  "stock:count",
  "stock:oversell",
  "stock:rebuild",
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
    "stock:transfer",
    "stock:count",
    "stock:oversell",
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
    "stock:transfer",
    "stock:count",
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
    "sale:read_all",
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
    "audit:read",
  ]),

  // Auditor: read-only everywhere, including the audit chain itself.
  auditor: new Set<Permission>([
    "product:read",
    "supplier:read",
    "customer:read",
    "stock:read",
    "sale:read_all",
    "invoice:read",
    "invoice:read_all",
    "payment:read",
    "payment:read_all",
    "dashboard:read",
    "dashboard:read_financials",
    "report:export",
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
