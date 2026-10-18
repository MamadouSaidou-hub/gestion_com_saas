import { describe, expect, it } from "vitest";
import { isDuplicateCategoryName, wouldCreateCycle } from "./category";

describe("wouldCreateCycle", () => {
  const tree = [
    { id: "root", parentId: null },
    { id: "breakfast", parentId: "root" },
    { id: "coffee", parentId: "breakfast" },
    { id: "espresso", parentId: "coffee" },
    { id: "drinks", parentId: "root" }, // unrelated sibling subtree
  ];

  it("rejects a category becoming its own parent", () => {
    expect(wouldCreateCycle(tree, "breakfast", "breakfast")).toBe(true);
  });

  it("rejects moving a category under its own direct child", () => {
    expect(wouldCreateCycle(tree, "breakfast", "coffee")).toBe(true);
  });

  it("rejects moving a category under a deeper descendant", () => {
    expect(wouldCreateCycle(tree, "breakfast", "espresso")).toBe(true);
  });

  it("allows moving a category under an unrelated subtree", () => {
    expect(wouldCreateCycle(tree, "coffee", "drinks")).toBe(false);
  });

  it("allows moving a category to top-level ancestor that is not a descendant", () => {
    expect(wouldCreateCycle(tree, "espresso", "root")).toBe(false);
  });

  it("allows a brand-new category (not yet in the snapshot) to be parented anywhere", () => {
    expect(wouldCreateCycle(tree, "new-category", "coffee")).toBe(false);
  });

  it("does not loop forever against a pre-existing corrupt cycle unrelated to this move", () => {
    const corrupt = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
      { id: "c", parentId: null },
    ];
    // Moving unrelated "c" under "a" should terminate and report false --
    // the a<->b cycle already existed and is not something this move creates.
    expect(wouldCreateCycle(corrupt, "c", "a")).toBe(false);
  });
});

describe("isDuplicateCategoryName", () => {
  it("flags an exact, case-insensitive match", () => {
    expect(isDuplicateCategoryName(["Boissons", "Snacks"], "boissons")).toBe(true);
    expect(isDuplicateCategoryName(["Boissons"], "BOISSONS")).toBe(true);
  });

  it("trims whitespace before comparing", () => {
    expect(isDuplicateCategoryName(["Boissons"], "  Boissons  ")).toBe(true);
  });

  it("does not flag a different name", () => {
    expect(isDuplicateCategoryName(["Boissons", "Snacks"], "Petit dejeuner")).toBe(false);
  });

  it("never treats % or _ in the candidate as a wildcard (same bug class as the M1 fix)", () => {
    // A literal name containing SQL LIKE wildcard characters must only ever
    // match that exact literal string, never pattern-match an unrelated
    // sibling the way an unescaped ILIKE would.
    expect(isDuplicateCategoryName(["Boissons"], "Bois%")).toBe(false);
    expect(isDuplicateCategoryName(["Bois%sons"], "Bois%sons")).toBe(true);
  });

  it("returns false against an empty sibling list (first category at this level)", () => {
    expect(isDuplicateCategoryName([], "Petit dejeuner")).toBe(false);
  });
});
