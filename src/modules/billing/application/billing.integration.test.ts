import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_URL, MIGRATOR_URL } from "@/test/integration/db-constants";
import { seedStructure, createProduct, setStockLevel } from "@/test/integration/seed";
import type { Actor } from "@/modules/tenancy/types";
import type { ConfirmSaleInput } from "@/modules/sales";

// ---------------------------------------------------------------------------
// Billing standalone use cases (Phase 1 step 4) -- recordPayment,
// issueInvoiceForSale, voidPayment -- against the SAME disposable
// container convention as confirm-sale.integration.test.ts. Each test
// confirms a real sale through `salesService.confirmSale` first (the only
// way a sale can legitimately exist), then exercises the billing use case
// on top of it.
// ---------------------------------------------------------------------------

process.env.DATABASE_URL = process.env.DATABASE_URL ?? APP_URL;
process.env.DATABASE_URL_MIGRATOR = process.env.DATABASE_URL_MIGRATOR ?? MIGRATOR_URL;

let withTenantSession: typeof import("@/platform/db/withTenantSession").withTenantSession;
let salesService: typeof import("@/modules/sales").salesService;
let billingService: typeof import("@/modules/billing").billingService;
let OverpaymentErrorCtor: typeof import("@/modules/sales").PaymentExceedsTotalError;
let PaymentAlreadyVoidedErrorCtor: typeof import("@/modules/billing").PaymentAlreadyVoidedError;

beforeAll(async () => {
  ({ withTenantSession } = await import("@/platform/db/withTenantSession"));
  ({ salesService, PaymentExceedsTotalError: OverpaymentErrorCtor } = await import("@/modules/sales"));
  ({ billingService, PaymentAlreadyVoidedError: PaymentAlreadyVoidedErrorCtor } = await import(
    "@/modules/billing"
  ));
});

async function confirmCreditSale(fixture: Awaited<ReturnType<typeof seedStructure>>, productId: string) {
  const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner" };
  const input: ConfirmSaleInput = {
    idempotencyKey: `test-idem-${randomUUID()}`,
    warehouseId: fixture.warehouseId,
    currencyCode: "XOF",
    customerId: fixture.customerId,
    lines: [{ productId, quantity: "2.0000" }], // 2 * 1000 = 2000 total (0% VAT)
  };
  return withTenantSession(owner, (ctx) => salesService.confirmSale(ctx, input));
}

describe("billing standalone use cases", () => {
  it("recordPayment pays off a credit sale later, in its own transaction, idempotently", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-BILL-1", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "50.0000", 600);

    const sale = await confirmCreditSale(fixture, productId);
    expect(sale.paymentStatus).toBe("unpaid");

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner" };
    const paymentIdemKey = `test-payment-${randomUUID()}`;
    const recordInput = {
      idempotencyKey: paymentIdemKey,
      amountMinor: "2000",
      method: "cash" as const,
      saleId: sale.saleId,
    };

    const first = await withTenantSession(owner, (ctx) => billingService.recordPayment(ctx, recordInput));
    const second = await withTenantSession(owner, (ctx) => billingService.recordPayment(ctx, recordInput));

    expect(first.id).toBe(second.id); // same payment, not a second one
    expect(first.amountMinor).toBe("2000");

    const updatedSale = await withTenantSession(owner, (ctx) => salesService.getSaleForBilling(ctx, sale.saleId));
    expect(updatedSale?.paymentStatus).toBe("paid");
    expect(updatedSale?.paidMinor).toBe("2000");
  });

  it("recordPayment rejects an overpayment", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-BILL-2", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "50.0000", 600);

    const sale = await confirmCreditSale(fixture, productId); // total = 2000
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner" };

    await expect(
      withTenantSession(owner, (ctx) =>
        billingService.recordPayment(ctx, {
          idempotencyKey: `test-payment-${randomUUID()}`,
          amountMinor: "999999",
          method: "cash",
          saleId: sale.saleId,
        })
      )
    ).rejects.toThrow(OverpaymentErrorCtor);
  });

  it("issueInvoiceForSale is idempotent-ish: asking twice returns the same invoice", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-BILL-3", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "50.0000", 600);

    const sale = await confirmCreditSale(fixture, productId);
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner" };

    const first = await withTenantSession(owner, (ctx) => billingService.issueInvoiceForSale(ctx, sale.saleId));
    const second = await withTenantSession(owner, (ctx) => billingService.issueInvoiceForSale(ctx, sale.saleId));

    expect(first.id).toBe(second.id);
    expect(first.docNumber).toBe(second.docNumber);
    expect(first.saleId).toBe(sale.saleId);
  });

  it("voidPayment reverses a payment's effect on the sale", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-BILL-4", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "50.0000", 600);

    const sale = await confirmCreditSale(fixture, productId); // total = 2000
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner" };

    const payment = await withTenantSession(owner, (ctx) =>
      billingService.recordPayment(ctx, {
        idempotencyKey: `test-payment-${randomUUID()}`,
        amountMinor: "2000",
        method: "cash",
        saleId: sale.saleId,
      })
    );

    const afterPay = await withTenantSession(owner, (ctx) => salesService.getSaleForBilling(ctx, sale.saleId));
    expect(afterPay?.paymentStatus).toBe("paid");

    await withTenantSession(owner, (ctx) => billingService.voidPayment(ctx, payment.id));

    const afterVoid = await withTenantSession(owner, (ctx) => salesService.getSaleForBilling(ctx, sale.saleId));
    expect(afterVoid?.paymentStatus).toBe("unpaid");
    expect(afterVoid?.paidMinor).toBe("0");

    // Voiding a second time is rejected, not silently accepted.
    await expect(
      withTenantSession(owner, (ctx) => billingService.voidPayment(ctx, payment.id))
    ).rejects.toThrow(PaymentAlreadyVoidedErrorCtor);
  });

  // C1 (security-reviewer, Critical): two concurrent payments on the same
  // sale must NOT lose one of them. A plain `findById` (no lock) then an
  // absolute `UPDATE ... SET paid_minor = <computed>` loses whichever
  // write runs second -- this test is structurally incapable of passing
  // against that version; it only passes against the atomic
  // `paid_minor = paid_minor + delta ... WHERE ... BETWEEN 0 AND
  // total_minor` fix.
  it("(C1) two concurrent recordPayment calls on the same sale both land -- no lost update", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-C1-PAY", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "50.0000", 600);

    // total = 10 * 1000 = 10000, large enough that two 4000 payments don't overpay.
    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner" };
    const sale = await withTenantSession(owner, (ctx) =>
      salesService.confirmSale(ctx, {
        idempotencyKey: `test-idem-${randomUUID()}`,
        warehouseId: fixture.warehouseId,
        currencyCode: "XOF",
        customerId: fixture.customerId,
        lines: [{ productId, quantity: "10.0000" }],
      })
    );

    const [paymentA, paymentB] = await Promise.all([
      withTenantSession(owner, (ctx) =>
        billingService.recordPayment(ctx, {
          idempotencyKey: `concurrent-pay-a-${randomUUID()}`,
          amountMinor: "4000",
          method: "cash",
          saleId: sale.saleId,
        })
      ),
      withTenantSession(owner, (ctx) =>
        billingService.recordPayment(ctx, {
          idempotencyKey: `concurrent-pay-b-${randomUUID()}`,
          amountMinor: "4000",
          method: "mobile_money",
          saleId: sale.saleId,
        })
      ),
    ]);

    expect(paymentA.id).not.toBe(paymentB.id); // two distinct payment rows

    const finalSale = await withTenantSession(owner, (ctx) => salesService.getSaleForBilling(ctx, sale.saleId));
    // Both payments landed -- 4000 + 4000 = 8000, NOT 4000 (the lost-update symptom).
    expect(finalSale?.paidMinor).toBe("8000");
    expect(finalSale?.paymentStatus).toBe("partial");
  });

  it("(C1) two concurrent voidPayment calls on the same payment debit the balance exactly once", async () => {
    const fixture = await seedStructure();
    const productId = await createProduct(fixture, { sku: "SKU-C1-VOID", priceMinor: 1000, costMinor: 600 });
    await setStockLevel(fixture, productId, "50.0000", 600);

    const owner: Actor = { userId: fixture.ownerUserId, structureId: fixture.structureId, role: "owner" };
    const sale = await confirmCreditSale(fixture, productId); // total = 2000
    const payment = await withTenantSession(owner, (ctx) =>
      billingService.recordPayment(ctx, {
        idempotencyKey: `test-payment-${randomUUID()}`,
        amountMinor: "2000",
        method: "cash",
        saleId: sale.saleId,
      })
    );

    const results = await Promise.allSettled([
      withTenantSession(owner, (ctx) => billingService.voidPayment(ctx, payment.id)),
      withTenantSession(owner, (ctx) => billingService.voidPayment(ctx, payment.id)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1); // exactly one void wins
    expect(rejected).toHaveLength(1); // the other is refused, not silently a second debit

    const finalSale = await withTenantSession(owner, (ctx) => salesService.getSaleForBilling(ctx, sale.saleId));
    // Debited ONCE: 2000 - 2000 = 0, never negative (which a double-debit
    // would have driven it to, had the atomic bounds check not rejected it).
    expect(finalSale?.paidMinor).toBe("0");
    expect(finalSale?.paymentStatus).toBe("unpaid");
  });
});
