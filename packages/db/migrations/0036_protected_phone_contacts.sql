begin;

-- A single upgrade transaction may just have projected legacy proof in 0032.
-- Validate its deferred completion before altering that same relation.
set constraints phone_contact_binding_completion immediate;

-- Only a newly consumed SMS may supply a protected contact. Existing HMAC-only
-- bindings remain NULL; this migration never invents or recovers a raw number.
alter table phone_contact_bindings add column protected_phone text;
alter table phone_contact_bindings add constraint phone_contact_protected_phone_shape
  check (protected_phone is null or (method='phone_code' and length(protected_phone)<=256
    and protected_phone ~ '^pc1\.[a-f0-9]{64}\.[a-f0-9]{24}\.([a-f0-9]{2}){9,16}\.[a-f0-9]{32}$'));

-- The original proof row owns its envelope. Transfers reference that proof and
-- never copy it, and neither a retry nor an operator UPDATE may backfill it.
create function citygo_guard_protected_phone_contact() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='UPDATE' and new.protected_phone is distinct from old.protected_phone then
    raise exception 'Protected phone contact is immutable' using errcode='23514';
  end if;
  if new.protected_phone is not null and new.method<>'phone_code' then
    raise exception 'Protected phone contact requires its original SMS binding' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger phone_contact_protected_phone_guard before insert or update on phone_contact_bindings
  for each row execute function citygo_guard_protected_phone_contact();

set constraints phone_contact_binding_completion deferred;

commit;
