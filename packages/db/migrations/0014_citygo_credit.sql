begin;

-- Expand the existing integer ledger. Historical entries and provider receipts
-- remain unchanged; applying this migration does not activate payments or ×10.
alter table ai_credit_accounts
  drop constraint ai_credit_accounts_granted_micros_check,
  add constraint ai_credit_accounts_granted_micros_check
    check (granted_micros between 0 and 10000000000000);
alter table ai_credit_entries
  drop constraint ai_credit_entries_kind_check,
  drop constraint ai_credit_entries_amount_micros_check,
  drop constraint ai_credit_entries_check,
  add constraint ai_credit_entries_kind_check
    check (kind in ('bonus','topup','hold','settle','release')),
  add constraint ai_credit_entries_amount_micros_check
    check (amount_micros between 0 and 10000000000000),
  add constraint ai_credit_entries_check check (
    (kind='bonus' and amount_micros=500000000 and hold_id is null and actor_user_id is not null)
    or (kind='topup' and amount_micros>0 and hold_id is null and actor_user_id is null)
    or (kind='hold' and amount_micros>0 and hold_id is null and actor_user_id is null)
    or (kind in ('settle','release') and hold_id is not null and actor_user_id is null)
  );

alter table ai_credit_charges
  add column tariff_snapshot jsonb not null default
    '{"version":"legacy-at-cost-v1","realCurrency":"RUB","balanceUnit":"CITYGO_RUB","numerator":1,"denominator":1}'::jsonb,
  add column real_ceiling_micros bigint;
update ai_credit_charges c set real_ceiling_micros=e.amount_micros
  from ai_credit_entries e where e.operation_id=c.hold_id;
alter table ai_credit_charges
  add constraint ai_credit_charges_tariff_check check (
    tariff_snapshot='{"version":"legacy-at-cost-v1","realCurrency":"RUB","balanceUnit":"CITYGO_RUB","numerator":1,"denominator":1}'::jsonb
    or tariff_snapshot='{"version":"citygo-10x-v1","realCurrency":"RUB","balanceUnit":"CITYGO_RUB","numerator":10,"denominator":1}'::jsonb
  ),
  add constraint ai_credit_charges_real_ceiling_check check (
    (real_ceiling_micros is not null and real_ceiling_micros between 1 and 1000000000000)
    or (real_ceiling_micros is null and tariff_snapshot->>'version'='legacy-at-cost-v1')
  );

-- Only a trusted, separately verified server payment can create this record.
-- Neither possession of a payment ID nor a client-return URL proves payment.
create unique index ai_credit_entry_topup_identity on ai_credit_entries(operation_id,user_id,amount_micros);
create table ai_credit_topups (
  provider_payment_id text primary key check (provider_payment_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  operation_id uuid not null unique,
  user_id bigint not null references ai_credit_accounts(user_id),
  paid_kopeks bigint not null check (paid_kopeks between 1 and 1000000000),
  credited_micros bigint not null check (credited_micros=paid_kopeks*10000),
  merchant_id text not null check (merchant_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  test boolean not null,
  verified_at timestamptz not null,
  verification_receipt jsonb not null check (jsonb_typeof(verification_receipt)='object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(operation_id,user_id,credited_micros)
    references ai_credit_entries(operation_id,user_id,amount_micros)
);
create index ai_credit_topups_user on ai_credit_topups(user_id,created_at desc);

commit;
