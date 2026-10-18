import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/modules/identity/get-session";
import { resolveActor } from "@/modules/tenancy/resolve-actor";
import { can } from "@/modules/tenancy/permissions";
import { withTenantSession } from "@/platform/db/withTenantSession";
import { structures } from "@/db/schema/tenancy";
import { NotAMemberError, UnauthenticatedError } from "@/platform/errors";
import { formatMoney, type SupportedCurrency } from "@/lib/money";
import { dict } from "@/lib/i18n";
import { Breadcrumb } from "@/components/nav/breadcrumb";
import { salesService } from "@/modules/sales";
import { billingService } from "@/modules/billing";
import { catalogService } from "@/modules/catalog";
import { PrintButton } from "./print-button";
import { IssueInvoiceButton } from "./issue-invoice-button";

// Gated, structure-scoped page: /s/[structureId]/ventes/[saleId] -- the
// printable ticket/invoice document. `getSaleDetail` returns `null` for
// ANY out-of-scope access (wrong owner, wrong store) -- this is what turns
// that into a plain 404, never a detailed 403 (no existence oracle), per
// the task's explicit instruction.
export const dynamic = "force-dynamic";

function currencyForCountry(countryCode: string): SupportedCurrency {
  return countryCode === "GN" ? "GNF" : "XOF";
}

export default async function SaleDocumentPage({
  params,
}: {
  params: Promise<{ structureId: string; saleId: string }>;
}) {
  const { structureId, saleId } = await params;

  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  let actor;
  try {
    actor = await resolveActor(session, structureId);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      redirect("/login");
    }
    if (err instanceof NotAMemberError) {
      notFound();
    }
    throw err;
  }

  const data = await withTenantSession(actor, async (ctx) => {
    const [structureRow] = await ctx.db
      .select({ name: structures.name, countryCode: structures.countryCode })
      .from(structures)
      .where(eq(structures.id, actor.structureId))
      .limit(1);
    if (!structureRow) {
      return null;
    }

    const sale = await salesService.getSaleDetail(ctx, saleId);
    if (!sale) {
      return null;
    }

    const [invoice, products, warehouses] = await Promise.all([
      billingService.getInvoiceForSale(ctx, saleId),
      catalogService.listProducts(ctx, {}),
      catalogService.listWarehouses(ctx, {}),
    ]);
    const productNameById = new Map(products.map((p) => [p.id, { name: p.name, sku: p.sku }]));
    const warehouseNameById = new Map(warehouses.map((w) => [w.id, w.name]));

    return {
      structureName: structureRow.name,
      countryCode: structureRow.countryCode,
      sale,
      invoice,
      storeName: warehouseNameById.get(sale.warehouseId) ?? sale.warehouseId,
      lines: sale.lines.map((line) => ({
        ...line,
        productName: productNameById.get(line.productId)?.name ?? line.productId,
      })),
    };
  });

  if (!data) {
    notFound();
  }

  const canIssueInvoice = can(actor, "invoice:issue");
  const currency = currencyForCountry(data.countryCode);
  const { sale, invoice } = data;
  const isInvoice = invoice !== null;
  const docTitle = isInvoice ? dict.saleDocument.invoiceTitle : dict.saleDocument.ticketTitle;
  const docNumberLabel = isInvoice ? dict.saleDocument.invoiceLabel : dict.saleDocument.ticketLabel;
  const docNumber = isInvoice ? invoice.docNumber : sale.ticketNumber ?? "--";
  const balanceMinor = Number(sale.totalMinor) - Number(sale.paidMinor);

  return (
    <div className="min-h-screen bg-background pb-6 print:bg-white print:pb-0">
      {/* @media print rules: hide the app chrome/buttons, reset the
          document to a plain printable page -- no client-side PDF
          library, this is plain CSS evaluated by the browser's own print
          engine. */}
      <style>{`
        @media print {
          body { background: white; }
          .print\\:hidden { display: none !important; }
        }
      `}</style>

      <header className="sticky top-0 z-30 border-b border-border bg-card px-4 py-3 print:hidden">
        <div className="flex items-center justify-between gap-2">
          <a
            href={`/s/${structureId}/ventes`}
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            &larr; {dict.saleDocument.backCta}
          </a>
          <div className="flex items-center gap-2">
            {!isInvoice && canIssueInvoice && (
              <IssueInvoiceButton structureId={structureId} saleId={sale.id} />
            )}
            <PrintButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-md px-4 py-6 print:max-w-none print:px-0">
        <Breadcrumb
          items={[
            { label: dict.nav.dashboard, href: `/s/${structureId}/dashboard` },
            { label: dict.salesHistory.title, href: `/s/${structureId}/ventes` },
            { label: docTitle },
          ]}
        />

        <div className="rounded-lg border border-border bg-card p-6 print:border-none print:p-0">
          <h1 className="text-center text-lg font-semibold">{data.structureName}</h1>
          <p className="text-center text-sm text-muted-foreground">{data.storeName}</p>
          <h2 className="mt-4 text-center text-base font-medium">{docTitle}</h2>
          <p className="text-center text-sm text-muted-foreground">
            {docNumberLabel} {docNumber}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            {dict.saleDocument.dateLabel}: {sale.confirmedAt ? new Date(sale.confirmedAt).toLocaleString("fr-FR") : "--"}
          </p>

          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-1">Produit</th>
                <th className="py-1 text-right">Qté</th>
                <th className="py-1 text-right">P.U.</th>
                <th className="py-1 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((line) => (
                <tr key={line.lineNo} className="border-b border-border/50">
                  <td className="py-1">{line.productName}</td>
                  <td className="py-1 text-right tabular-nums">{line.quantity}</td>
                  <td className="py-1 text-right tabular-nums">
                    {formatMoney(Number(line.unitPriceMinor), currency)}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {formatMoney(Number(line.lineTotalMinor), currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{dict.saleDocument.subtotalLabel}</dt>
              <dd className="tabular-nums">{formatMoney(Number(sale.subtotalMinor), currency)}</dd>
            </div>
            {Number(sale.discountMinor) > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{dict.saleDocument.discountLabel}</dt>
                <dd className="tabular-nums">-{formatMoney(Number(sale.discountMinor), currency)}</dd>
              </div>
            )}
            {Number(sale.vatMinor) > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{dict.saleDocument.vatLabel}</dt>
                <dd className="tabular-nums">{formatMoney(Number(sale.vatMinor), currency)}</dd>
              </div>
            )}
            <div className="flex justify-between font-semibold">
              <dt>{dict.saleDocument.totalLabel}</dt>
              <dd className="tabular-nums">{formatMoney(Number(sale.totalMinor), currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{dict.saleDocument.paidLabel}</dt>
              <dd className="tabular-nums">{formatMoney(Number(sale.paidMinor), currency)}</dd>
            </div>
            {balanceMinor > 0 && (
              <div className="flex justify-between font-medium">
                <dt>{dict.saleDocument.balanceLabel}</dt>
                <dd className="tabular-nums">{formatMoney(balanceMinor, currency)}</dd>
              </div>
            )}
          </dl>
        </div>
      </main>
    </div>
  );
}
