import { describe, expect, it } from "vitest";
import { escapeCsvCell, rowsToCsv } from "./csv";

describe("escapeCsvCell", () => {
  it("prefixes a leading '=' to defuse a formula-injection payload", () => {
    expect(escapeCsvCell("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
  });

  it("prefixes a leading '+'", () => {
    expect(escapeCsvCell("+1+1")).toBe("'+1+1");
  });

  it("prefixes a leading '-'", () => {
    expect(escapeCsvCell("-2+3")).toBe("'-2+3");
  });

  it("prefixes a leading '@'", () => {
    // Also contains a comma -- quoted on top of the defusing prefix, same
    // combined-defense case as the dedicated test below.
    expect(escapeCsvCell("@SUM(1,1)")).toBe('"\'@SUM(1,1)"');
  });

  it("leaves an ordinary cell untouched", () => {
    expect(escapeCsvCell("Boutique Fatou")).toBe("Boutique Fatou");
  });

  it("quotes a cell containing a comma", () => {
    expect(escapeCsvCell("Dupont, Awa")).toBe('"Dupont, Awa"');
  });

  it("escapes embedded double quotes", () => {
    expect(escapeCsvCell('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("defuses AND quotes a formula payload that also contains a comma", () => {
    // Order matters: the defusing apostrophe must be applied BEFORE
    // quoting, so the malicious payload never reaches a spreadsheet
    // engine as a leading '=' even once re-wrapped in quotes.
    expect(escapeCsvCell("=1+1,2")).toBe('"\'=1+1,2"');
  });
});

describe("rowsToCsv", () => {
  it("escapes a malicious product/customer name across a full row", () => {
    const rows = [{ name: "=cmd|' /C calc'!A0", amount: "1000" }];
    const csv = rowsToCsv(rows, [
      { header: "Nom", value: (r) => r.name },
      { header: "Montant", value: (r) => r.amount },
    ]);
    expect(csv).toContain("'=cmd|' /C calc'!A0");
    expect(csv).not.toMatch(/(?<!')=cmd/);
  });

  it("produces a UTF-8 BOM + CRLF-terminated CSV with the header row first", () => {
    const rows = [{ a: "1" }];
    const csv = rowsToCsv(rows, [{ header: "A", value: (r) => r.a }]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("A\r\n1\r\n");
  });
});
