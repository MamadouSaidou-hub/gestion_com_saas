import { describe, expect, it } from "vitest";
import { buildRetryBatch, isExpired, scopeKeyFor, type QueuedSale } from "./offline-sales-queue";

// Pure-logic tests only -- real IndexedDB isn't available in this
// project's node-based vitest environment (see offline-sales-queue.ts's
// header comment); the I/O functions (enqueueSale/updateSale/...) were
// validated by hand against a running browser instead.

function makeEntry(overrides: Partial<QueuedSale<{ total: number }>> = {}): QueuedSale<{ total: number }> {
  return {
    idempotencyKey: "fixed-key-123",
    scopeKey: scopeKeyFor("structure-1", "user-1"),
    payload: { total: 1000 },
    createdAt: Date.now(),
    status: "pending",
    ...overrides,
  };
}

describe("buildRetryBatch -- idempotency key discipline", () => {
  it("never regenerates the idempotency key on retry -- same object, same key", () => {
    const entry = makeEntry();
    const { toRetry } = buildRetryBatch([entry], Date.now());
    expect(toRetry).toHaveLength(1);
    expect(toRetry[0]).toBe(entry); // literal same reference -- nothing rebuilt
    expect(toRetry[0].idempotencyKey).toBe("fixed-key-123");
  });

  it("retries the SAME key across multiple retry passes, never a fresh one", () => {
    const entry = makeEntry();
    const pass1 = buildRetryBatch([entry], Date.now()).toRetry[0];
    const pass2 = buildRetryBatch([pass1], Date.now()).toRetry[0];
    expect(pass1.idempotencyKey).toBe(entry.idempotencyKey);
    expect(pass2.idempotencyKey).toBe(entry.idempotencyKey);
  });

  it("does not retry an entry that is already confirmed or errored", () => {
    const confirmed = makeEntry({ status: "confirmed", idempotencyKey: "a" });
    const errored = makeEntry({ status: "error", idempotencyKey: "b" });
    const { toRetry, toExpire } = buildRetryBatch([confirmed, errored], Date.now());
    expect(toRetry).toHaveLength(0);
    expect(toExpire).toHaveLength(0);
  });

  it("expires a pending entry once the accounting day it was created on has ended (M4: not a rolling 24h)", () => {
    // Created at 23:00 UTC -- still pending 2 hours later, at 01:00 UTC
    // the NEXT day: a rolling 24h window would still consider this
    // fresh (only 2h old), but it has crossed the accounting-day
    // boundary and must expire rather than risk landing in the wrong
    // day's revenue.
    const createdAt = Date.UTC(2026, 0, 15, 23, 0, 0); // 2026-01-15T23:00:00Z
    const twoHoursLater = Date.UTC(2026, 0, 16, 1, 0, 0); // 2026-01-16T01:00:00Z
    const entry = makeEntry({ idempotencyKey: "late-night", createdAt });
    const { toRetry, toExpire } = buildRetryBatch([entry], twoHoursLater);
    expect(toRetry).toHaveLength(0);
    expect(toExpire).toEqual([entry]);
  });

  it("still retries a pending entry created and checked on the SAME accounting day", () => {
    const createdAt = Date.UTC(2026, 0, 15, 9, 0, 0);
    const laterSameDay = Date.UTC(2026, 0, 15, 23, 59, 0);
    const entry = makeEntry({ idempotencyKey: "same-day", createdAt });
    const { toRetry, toExpire } = buildRetryBatch([entry], laterSameDay);
    expect(toRetry).toEqual([entry]);
    expect(toExpire).toHaveLength(0);
  });
});

describe("isExpired", () => {
  it("is false within the same UTC day and true once the day rolls over", () => {
    const createdAt = Date.UTC(2026, 5, 1, 10, 0, 0);
    expect(isExpired({ createdAt }, Date.UTC(2026, 5, 1, 23, 59, 59))).toBe(false);
    expect(isExpired({ createdAt }, Date.UTC(2026, 5, 2, 0, 0, 0))).toBe(true);
  });
});

describe("scopeKeyFor (M4)", () => {
  it("combines structureId and userId so a shared till can't mix up two cashiers' queues", () => {
    expect(scopeKeyFor("struct-1", "user-a")).toBe("struct-1:user-a");
    expect(scopeKeyFor("struct-1", "user-a")).not.toBe(scopeKeyFor("struct-1", "user-b"));
  });
});
