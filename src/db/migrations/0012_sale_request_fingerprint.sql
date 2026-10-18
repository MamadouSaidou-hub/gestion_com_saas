-- ============================================================================
-- 0012_sale_request_fingerprint.sql (hand-written)
--
-- H1 (security-reviewer, High, Phase 1 post-ship fix): on an idempotency-
-- key conflict, confirmSale returned the existing sale with NO comparison
-- against the NEW request's payload. A cashier replaying a previously-used
-- key with a DIFFERENT cart got a valid-looking ticket for the OLD sale --
-- goods out, no new sale/stock movement/payment/audit entry for what was
-- actually rung up. Adds a fingerprint column so a replay can be verified,
-- not just assumed.
--
-- NOT NULL with no default: every sale from here on must carry one;
-- confirmSale always computes and inserts it in the same INSERT that
-- claims the idempotency key, so there is no window where a row exists
-- without it in a correctly-functioning app layer. Existing rows (none in
-- any real tenant yet, business layer is pre-launch) are backfilled to a
-- placeholder so the NOT NULL constraint can be added without failing.
-- ============================================================================

alter table sales add column if not exists request_fingerprint text;

update sales set request_fingerprint = 'backfilled-pre-0012' where request_fingerprint is null;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'sales' and column_name = 'request_fingerprint' and is_nullable = 'NO'
  ) then
    alter table sales alter column request_fingerprint set not null;
  end if;
end $$;
