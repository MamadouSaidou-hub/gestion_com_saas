import { describe, expect, it, vi } from "vitest";
import { createAuditWriter, AuditPayloadPiiError } from "./audit-writer";
import type { TenantTx } from "@/platform/db/withTenantSession";
import type { Actor } from "@/modules/tenancy/types";

// M6 (security-reviewer finding): proves the PII/secret denylist on audit
// payloads actually rejects an unexpected field, and that it never reaches
// the DB (audit_log_append is append-only -- better to throw before the
// call than after).

const actor: Actor = {
  userId: "user_1",
  structureId: "11111111-1111-1111-1111-111111111111",
  role: "owner",
  warehouseId: null,
};

function makeFakeTx(): TenantTx {
  // Only `.execute` is exercised by createAuditWriter -- stub just that,
  // cast through unknown since a full TenantTx is a large drizzle type we
  // don't need for this pure-logic test.
  return {
    execute: vi.fn().mockResolvedValue([{ audit_log_append: "1" }]),
  } as unknown as TenantTx;
}

describe("AuditWriter PII guard (M6)", () => {
  it("rejects a payload with an unexpected PII-like key", async () => {
    const tx = makeFakeTx();
    const writer = createAuditWriter(tx, actor);

    await expect(
      writer.append({
        action: "customer.created",
        targetType: "customer",
        payload: { name: "ACME", phone: "+221771234567" },
      })
    ).rejects.toThrow(AuditPayloadPiiError);

    // The whole point: never even reach the DB call for a rejected payload.
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("rejects a PII-like key nested inside the payload", async () => {
    const tx = makeFakeTx();
    const writer = createAuditWriter(tx, actor);

    await expect(
      writer.append({
        action: "settings.changed",
        targetType: "structure",
        payload: { before: { ownerEmail: "old@example.com" }, after: {} },
      })
    ).rejects.toThrow(AuditPayloadPiiError);
  });

  it("allows a normal, non-PII payload", async () => {
    const tx = makeFakeTx();
    const writer = createAuditWriter(tx, actor);

    const id = await writer.append({
      action: "settings.changed",
      targetType: "structure",
      targetId: actor.structureId,
      payload: { field: "name", before: "Old Name", after: "New Name" },
    });

    expect(id).toBe(1n);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it("allows an explicitly allowlisted key that would otherwise match the denylist", async () => {
    const tx = makeFakeTx();
    const writer = createAuditWriter(tx, actor);

    await expect(
      writer.append({
        action: "settings.changed",
        targetType: "structure",
        payload: { field: "emailVerified", before: false, after: true },
        allowedPiiLikeKeys: ["emailVerified"],
      })
    ).resolves.toBe(1n);
  });
});
