-- ============================================================================
-- 0011_invoice_sale_idempotent_issue.sql (hand-written)
--
-- Gap found while implementing `issueInvoiceForSale` (Phase 1 step 4): the
-- user explicitly asked for "idempotent-ish: asking twice for the same sale
-- returns the existing invoice rather than burning a second number." A
-- plain check-then-insert (SELECT invoice WHERE sale_id = ..., then INSERT
-- if none found) is a race between two concurrent requests for the SAME
-- sale -- both could pass the check and both insert, burning two invoice
-- numbers for one sale. A partial unique index turns this into the same
-- `ON CONFLICT ... DO NOTHING RETURNING *` pattern `confirmSale` already
-- uses for its own idempotency key, which IS race-free.
--
-- Partial (not a plain unique constraint) because `sale_id` is nullable --
-- a standalone invoice with no prior ticket (walk-up invoicing, not this
-- phase's primary flow but not disallowed by the schema either) must still
-- be insertable with sale_id = NULL, and Postgres unique constraints treat
-- multiple NULLs as distinct already -- the `WHERE sale_id IS NOT NULL`
-- predicate here is for clarity/documentation, not strictly required for
-- NULL-handling, but IS required for `ON CONFLICT (structure_id, sale_id)
-- WHERE sale_id IS NOT NULL` to have a matching index to infer against.
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'invoices_structure_sale_id_unique_idx'
  ) then
    create unique index invoices_structure_sale_id_unique_idx
      on invoices (structure_id, sale_id)
      where sale_id is not null;
  end if;
end $$;

-- ============================================================================
-- Verification performed (disposable postgres:16-alpine container, chain
-- 0000->0011 + identity 0000->0001, migrator role):
--   - re-running this file a second time against an already-migrated
--     database is a no-op (confirmed by execution).
--   - two sequential `insert into invoices (..., sale_id) values (..., X)`
--     for the SAME sale_id X -> second one rejected with a unique
--     violation (23505) on this index, confirming
--     `ON CONFLICT (structure_id, sale_id) WHERE sale_id IS NOT NULL DO
--     NOTHING` has a matching index to infer against.
--   - `insert into invoices (..., sale_id) values (..., NULL)` twice ->
--     both succeed (NULLs are distinct), confirming standalone invoices
--     with no sale are unaffected.
-- ============================================================================
