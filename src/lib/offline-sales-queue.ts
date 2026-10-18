// ---------------------------------------------------------------------------
// POS retry queue (CLAUDE.md D1 -- resilient PWA, NOT offline-first).
//
// The idempotency key is generated ONCE, by the caller (the POS client,
// at the moment the cashier taps "Encaisser"), and stored here alongside
// the payload. This module NEVER generates a key itself, and
// `buildRetryBatch` below NEVER mutates/replaces an entry's key --
// regenerating it on retry would guarantee a duplicate sale, since
// `confirmSale`'s idempotency arbiter is keyed on exactly this value.
// (Reviewer-confirmed correct -- untouched by the M4 fix below.)
//
// M4 fix (security-reviewer, Medium): the store used to be keyed by
// idempotencyKey alone with no user/structure scoping and no purge on
// logout -- on a SHARED till, a pending sale queued by cashier A could get
// submitted under cashier B's now-active session (wrong `created_by`,
// wrong per-seller dashboard breakdown). Every entry now carries a
// `scopeKey` (`${structureId}:${userId}`), and `listQueuedSales`/
// `purgeScope` are scoped by it. `purgeScope` is exported for a future
// logout hook to call -- this app has no logout button wired yet
// (pre-existing gap, not introduced here); flagged in the final report.
//
// Also M4: expiry is now "end of the accounting day the entry was
// CREATED on" (UTC, matching analytics/domain/period.ts's own UTC-day
// assumption), not a rolling 24h window -- a sale queued at 23:00 that
// only confirms after midnight used to be able to replay into the WRONG
// day with no trace; now it expires into "à ressaisir" at the day
// boundary instead of silently crossing it.
//
// `buildRetryBatch` is pure and DB-free (unit-tested in
// `offline-sales-queue.test.ts`, without a real IndexedDB, which isn't
// available in the node vitest environment this project uses -- see that
// test file's header comment). Everything below it that touches
// `indexedDB` is browser-only and can't be exercised by the node test
// runner; it was validated by hand against a running browser instead (see
// the subagent's final report for what was actually driven end to end).
// ---------------------------------------------------------------------------

const DB_NAME = "pos-sales-queue";
const DB_VERSION = 1;
const STORE_NAME = "queued_sales";

export type QueuedSaleStatus = "pending" | "confirmed" | "error" | "expired";

export interface QueuedSale<TPayload> {
  idempotencyKey: string; // primary key -- generated ONCE by the caller, never here
  scopeKey: string; // `${structureId}:${userId}` -- M4 fix, see header comment
  payload: TPayload;
  createdAt: number;
  status: QueuedSaleStatus;
  ticketNumber?: string;
  errorMessage?: string;
  // H1 fix (security-reviewer, High): true when the server resolved this
  // confirm call to an ALREADY-EXISTING sale (idempotency replay) instead
  // of confirming a new one -- the POS UI must show this distinctly
  // ("vente déjà enregistrée, ticket n° X"), never silently treat it the
  // same as a fresh confirmation.
  replayed?: boolean;
}

export function scopeKeyFor(structureId: string, userId: string): string {
  return `${structureId}:${userId}`;
}

// End of the UTC day `createdAt` falls on -- i.e. the start of the NEXT
// UTC day. Matches analytics/domain/period.ts's "the accounting day IS
// the UTC day" assumption (Senegal and Guinea are both UTC+0).
function endOfAccountingDay(createdAtMs: number): number {
  const created = new Date(createdAtMs);
  return Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate() + 1);
}

export function isExpired(entry: Pick<QueuedSale<unknown>, "createdAt">, now: number = Date.now()): boolean {
  return now >= endOfAccountingDay(entry.createdAt);
}

// Pure decision function: which pending entries are safe to resend as-is,
// and which have aged past the end of their accounting day and must be
// surfaced as "à ressaisir" instead of being silently replayed into a
// DIFFERENT day's revenue. Every entry returned in `toRetry` is the SAME
// object (same `idempotencyKey` reference) that was passed in -- nothing
// here constructs a new one.
export function buildRetryBatch<T>(
  entries: QueuedSale<T>[],
  now: number = Date.now()
): { toRetry: QueuedSale<T>[]; toExpire: QueuedSale<T>[] } {
  const toRetry: QueuedSale<T>[] = [];
  const toExpire: QueuedSale<T>[] = [];
  for (const entry of entries) {
    if (entry.status !== "pending") {
      continue;
    }
    if (isExpired(entry, now)) {
      toExpire.push(entry);
    } else {
      toRetry.push(entry);
    }
  }
  return { toRetry, toExpire };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "idempotencyKey" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, mode);
  const store = tx.objectStore(STORE_NAME);
  return fn(store);
}

// Persists a NEW queued sale. Called exactly once per "Encaisser" tap --
// `entry.idempotencyKey` must already be generated by the caller.
export async function enqueueSale<T>(entry: QueuedSale<T>): Promise<void> {
  await withStore("readwrite", (store) => requestToPromise(store.put(entry)));
}

export async function updateSale<T>(idempotencyKey: string, patch: Partial<QueuedSale<T>>): Promise<void> {
  await withStore("readwrite", async (store) => {
    const existing = await requestToPromise(store.get(idempotencyKey) as IDBRequest<QueuedSale<T> | undefined>);
    if (!existing) {
      return;
    }
    await requestToPromise(store.put({ ...existing, ...patch }));
  });
}

// M4 fix: scoped by `${structureId}:${userId}` -- a shared till switching
// cashiers never sees (or silently inherits) another cashier's queue.
export async function listQueuedSales<T>(scopeKey: string): Promise<QueuedSale<T>[]> {
  const all = await withStore("readonly", (store) =>
    requestToPromise(store.getAll() as IDBRequest<QueuedSale<T>[]>)
  );
  return all.filter((entry) => entry.scopeKey === scopeKey);
}

export async function removeSale(idempotencyKey: string): Promise<void> {
  await withStore("readwrite", (store) => requestToPromise(store.delete(idempotencyKey)));
}

// M4 fix: purge every queued entry for a given scope -- intended to be
// called on logout (not wired to a logout button yet, this app has none;
// see header comment) so a signed-out cashier's pending/error entries
// never linger to be picked up by whoever signs in next on the same
// device.
export async function purgeScope(scopeKey: string): Promise<void> {
  await withStore("readwrite", async (store) => {
    const all = await requestToPromise(store.getAll() as IDBRequest<QueuedSale<unknown>[]>);
    await Promise.all(
      all.filter((entry) => entry.scopeKey === scopeKey).map((entry) => requestToPromise(store.delete(entry.idempotencyKey)))
    );
  });
}

// L-c fix (security-reviewer follow-up): `listQueuedSales`/`buildRetryBatch`
// are scoped by `scopeKey` (M4) -- which means a PENDING/ERROR/EXPIRED
// entry belonging to a DIFFERENT cashier on a shared till is never listed,
// never retried, and never expired by the normal flow, so it would
// otherwise sit in IndexedDB forever (carts, customer names,
// accumulating indefinitely). This is a scope-INDEPENDENT sweep, deleting
// any entry that is EXPIRED (by the same end-of-accounting-day rule)
// regardless of which scope it belongs to -- intended to run once on app
// startup, not on every render. Still-pending entries for other scopes
// are left alone (only their owning session's retry loop should touch
// them); this only reclaims the ones that have aged past being useful to
// anyone.
export async function gcExpiredAcrossScopes(now: number = Date.now()): Promise<void> {
  await withStore("readwrite", async (store) => {
    const all = await requestToPromise(store.getAll() as IDBRequest<QueuedSale<unknown>[]>);
    // Any status, once its accounting day has passed -- a `confirmed`
    // entry only needs to linger long enough for its OWN session's queue
    // panel to show the ticket number (seconds), not forever.
    const toDelete = all.filter((entry) => isExpired(entry, now));
    await Promise.all(toDelete.map((entry) => requestToPromise(store.delete(entry.idempotencyKey))));
  });
}
