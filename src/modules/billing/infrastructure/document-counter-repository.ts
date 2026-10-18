import { and, eq, sql } from "drizzle-orm";
import { documentCounters } from "@/db/schema/billing";
import type { TenantSessionContext } from "@/platform/db/withTenantSession";
import type { DocumentCounterRepository } from "../application/ports";

// ---------------------------------------------------------------------------
// Gapless document numbering (D4's "document_counters" table). Allocation
// sequence, all inside the caller's transaction:
//   1. INSERT ... ON CONFLICT DO NOTHING -- creates the (structure, docType,
//      fiscalYear) counter row starting at next_value = 1 if it doesn't
//      exist yet; a no-op if it already does.
//   2. SELECT next_value ... FOR UPDATE -- locks the row. This is the ONE
//      lock that serializes every confirmSale call for this tenant+
//      fiscalYear+docType; callers are expected to acquire it as LATE as
//      possible.
//   3. UPDATE next_value = next_value + 1 -- releases the allocated number
//      for the next caller once this transaction commits (or rolls back
//      the increment with it, in which case the number is NOT burned).
// ---------------------------------------------------------------------------
export const documentCounterRepository: DocumentCounterRepository = {
  async allocateNext(
    ctx: TenantSessionContext,
    docType: "ticket" | "invoice" | "quote" | "credit_note" | "delivery_note",
    fiscalYear: number
  ): Promise<bigint> {
    await ctx.db
      .insert(documentCounters)
      .values({
        structureId: ctx.actor.structureId,
        docType,
        fiscalYear,
        nextValue: 1n,
      })
      .onConflictDoNothing({
        target: [documentCounters.structureId, documentCounters.docType, documentCounters.fiscalYear],
      });

    const [locked] = await ctx.db
      .select({ nextValue: documentCounters.nextValue })
      .from(documentCounters)
      .where(
        and(
          eq(documentCounters.structureId, ctx.actor.structureId),
          eq(documentCounters.docType, docType),
          eq(documentCounters.fiscalYear, fiscalYear)
        )
      )
      .for("update");

    const allocated = locked.nextValue;

    await ctx.db
      .update(documentCounters)
      .set({ nextValue: sql`${documentCounters.nextValue} + 1` })
      .where(
        and(
          eq(documentCounters.structureId, ctx.actor.structureId),
          eq(documentCounters.docType, docType),
          eq(documentCounters.fiscalYear, fiscalYear)
        )
      );

    return allocated;
  },
};
