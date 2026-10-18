import { sql } from "drizzle-orm";
import type { Actor } from "@/modules/tenancy/types";
import type { TenantTx } from "@/platform/db/withTenantSession";

// ---------------------------------------------------------------------------
// AuditWriter -- the ONLY way app code appends to audit_log.
//
// app_user has no direct INSERT on audit_log (revoked in
// 0001_tenancy_rls_audit.sql); the only path is EXECUTE on the SECURITY
// DEFINER function `audit_log_append(...)`, which fully controls
// prev_hash/entry_hash/seq via its own BEFORE INSERT trigger. This wrapper
// calls that function through the SAME drizzle transaction object as the
// business write it documents (`tx.execute(...)`, not a separate
// connection), so a rollback of one rolls back the other -- an audit entry
// can never exist for a write that didn't actually commit, and a write
// can never commit without ending up in the chain (callers are expected to
// call .append() before returning from their withTenantSession callback).
//
// `structureId` and `actorId` are taken from the already-verified `Actor`
// (see modules/tenancy/resolve-actor.ts), never from caller-supplied input --
// a caller cannot forge an audit entry attributed to a different tenant or
// user than the one withTenantSession actually scoped this transaction to.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M6 (security-reviewer finding) -- PII guard on audit payloads.
//
// `audit_log` is append-only and hash-chained: once a row is written it can
// never be edited or deleted (by design -- that's what makes the chain
// trustworthy). That also means it can never be used for anything that must
// eventually be deletable (a GDPR-style erasure request, a leaked secret
// that needs rotating out of every store, etc). A payload is free-form
// `Record<string, unknown>` today, so any future caller could accidentally
// write a phone number/email/raw token into a row that is architecturally
// undeletable.
//
// Fix: walk the payload (recursively, since nested objects/arrays are
// common -- e.g. `{ before: {...}, after: {...} }`) and throw if any key
// name looks like it holds PII or a secret, UNLESS the caller explicitly
// allowlists that exact key via `allowedPiiLikeKeys` (an intentional,
// visible opt-in at the call site -- not a global bypass). This is a
// denylist on KEY NAMES, not value content: it can't catch a phone number
// stuffed under an innocuous key, but it closes the common, accidental path
// (someone spreads a `customer`/`user` object straight into the payload).
// ---------------------------------------------------------------------------

export class AuditPayloadPiiError extends Error {
  constructor(keyPath: string) {
    super(
      `Audit payload contains a key that looks like PII/a secret: "${keyPath}". ` +
        `audit_log is append-only and can never be edited/deleted, so this key ` +
        `must be removed, replaced with a non-identifying reference (e.g. an id ` +
        `instead of a raw value), or explicitly allowlisted via ` +
        `"allowedPiiLikeKeys" on AuditEntryInput if you've confirmed it's safe ` +
        `for THIS entry.`
    );
    this.name = "AuditPayloadPiiError";
  }
}

// Key-name patterns that are denied by default. Deliberately broad and
// case-insensitive -- false positives (rejecting a legitimately safe key)
// are a cheap, loud build/runtime error the caller fixes by renaming the key
// or allowlisting it; false negatives (an undeletable PII leak) are not
// recoverable.
const DENYLISTED_KEY_PATTERNS: RegExp[] = [
  /phone/i,
  /e[-_]?mail/i,
  /password/i,
  /\bssn\b/i,
  /\biban\b/i,
  /card[-_]?number/i,
  /\bcvv\b/i,
  /\botp\b/i,
  /token/i,
  /secret/i,
  /api[-_]?key/i,
  /authoriz/i,
  /\baddress\b/i,
];

function isDenylistedKey(key: string): boolean {
  return DENYLISTED_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function assertNoSuspiciousKeys(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  path: string
): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSuspiciousKeys(item, allowedKeys, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (isDenylistedKey(key) && !allowedKeys.has(key)) {
      throw new AuditPayloadPiiError(keyPath);
    }
    assertNoSuspiciousKeys(nested, allowedKeys, keyPath);
  }
}

export interface AuditEntryInput {
  action: string; // e.g. 'settings.changed', 'sale.confirmed'
  targetType: string; // e.g. 'structure', 'sale'
  targetId?: string | null;
  payload?: Record<string, unknown>;
  requestId?: string | null;
  // Explicit, per-call opt-in for exact key names that would otherwise match
  // the PII/secret denylist (e.g. a boolean `emailVerified` flag). Only the
  // named keys are exempted; every other denylisted key in the same payload
  // still throws. Leave empty/omitted in the common case.
  allowedPiiLikeKeys?: string[];
}

export interface AuditWriter {
  append(entry: AuditEntryInput): Promise<bigint>;
}

export function createAuditWriter(tx: TenantTx, actor: Actor): AuditWriter {
  return {
    async append(entry: AuditEntryInput): Promise<bigint> {
      const allowedKeys = new Set(entry.allowedPiiLikeKeys ?? []);
      assertNoSuspiciousKeys(entry.payload ?? {}, allowedKeys, "");

      const rows = await tx.execute<{ audit_log_append: string }>(sql`
        select audit_log_append(
          ${actor.structureId}::uuid,
          ${actor.userId},
          ${actor.role},
          ${entry.action},
          ${entry.targetType},
          ${entry.targetId ?? null}::uuid,
          ${JSON.stringify(entry.payload ?? {})}::jsonb,
          ${entry.requestId ?? null}
        ) as audit_log_append
      `);
      return BigInt(rows[0].audit_log_append);
    },
  };
}
