import type { TenantSessionContext } from "@/platform/db/withTenantSession";

// ---------------------------------------------------------------------------
// CSV export -- shared server-side helper. Every export screen MUST:
//  1. Re-run the SAME filtered/scoped use case the list screen itself calls
//     (never a separate "export everything" query) -- the caller passes in
//     the rows it already fetched with the real filters/scope/permission
//     checks applied; this module only serializes them.
//  2. Escape CSV injection: a cell whose text starts with `=`, `+`, `-` or
//     `@` is a formula trigger in Excel/LibreOffice/Google Sheets when the
//     file is opened -- prefixed with a leading `'` (defuses the formula,
//     Excel shows the literal text instead) before any quoting.
//  3. Be logged to the audit chain by the CALLER (see `auditCsvExport`
//     below) -- exporting data is a sensitive read per CLAUDE.md.
// ---------------------------------------------------------------------------

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string;
}

const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@"]);

// Exported for unit testing the escaping rule in isolation.
export function escapeCsvCell(raw: string): string {
  let cell = raw;
  if (cell.length > 0 && FORMULA_TRIGGER_CHARS.has(cell[0])) {
    // Leading apostrophe: Excel/Sheets render it as literal text instead of
    // evaluating the rest as a formula. Applied BEFORE quoting below, so a
    // malicious value containing a comma/quote is still fully defused.
    cell = `'${cell}`;
  }
  if (/[",\r\n]/.test(cell)) {
    cell = `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

export function rowsToCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map((c) => escapeCsvCell(c.header)).join(",");
  const lines = rows.map((row) => columns.map((c) => escapeCsvCell(c.value(row))).join(","));
  // CRLF line endings (RFC 4180) + a leading UTF-8 BOM so Excel on Windows
  // (the realistic export destination for a shopkeeper) renders accented
  // French characters correctly instead of mangling them.
  return "﻿" + [headerLine, ...lines].join("\r\n") + "\r\n";
}

// auditCsvExport -- the ONE place every export writes its audit entry:
// action + the filters used + the row count, never the exported rows
// themselves (which may contain amounts but must never carry PII --
// `filters` here is expected to be ids/enums/dates only, same discipline as
// every other audit payload in this codebase; the PII guard in
// audit-writer.ts still throws if a caller slips a phone/email/address key
// in regardless).
export async function auditCsvExport(
  ctx: TenantSessionContext,
  params: { action: string; targetType: string; filters: Record<string, unknown>; rowCount: number }
): Promise<void> {
  await ctx.audit.append({
    action: params.action,
    targetType: params.targetType,
    targetId: null,
    payload: { filters: params.filters, rowCount: params.rowCount },
  });
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Exported data is per-actor/per-filter -- never cached by a shared
      // proxy/CDN (mobile-first slow-network caching rules per
      // performance.md apply to PUBLIC/static assets, not a sensitive,
      // permission-gated financial export).
      "Cache-Control": "no-store",
    },
  });
}
