begin;
-- User-visible operations only: operational holds/releases must not displace them.
-- One bounded branch per kind uses this index before the merged page LIMIT.
create index ai_credit_visible_history on ai_credit_entries(user_id,kind,created_at desc,id desc)
  where kind in ('bonus','topup','settle');
-- Resolve each successful refund to its first immutable terminal observation.
create index payment_refund_success_history on payment_refund_events(refund_id,sequence)
  where action='provider_observed' and payload->>'providerStatus'='succeeded';
commit;
