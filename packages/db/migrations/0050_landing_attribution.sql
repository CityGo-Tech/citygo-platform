begin;

-- Campaign labels are untrusted, bounded metadata, never authorization or URLs.
create function citygo_valid_landing_attribution(attribution jsonb) returns boolean
language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare item record;
begin
  if attribution is null then return true; end if;
  if jsonb_typeof(attribution)<>'object'
    or (jsonb_typeof(attribution->'landingVersion')='string') is not true
    or (attribution->>'landingVersion' in ('v1','v8')) is not true then
    return false;
  end if;
  for item in select * from jsonb_each(attribution) loop
    if item.key='landingVersion' then continue; end if;
    if item.key not in ('source','medium','campaignId','content')
      or jsonb_typeof(item.value)<>'string'
      or char_length(item.value #>> '{}') not between 1 and 80
      or (item.value #>> '{}') collate "C" !~ '^[a-z0-9][a-z0-9._-]{0,79}$'
      or (item.value #>> '{}') collate "C" ~ '[^a-z0-9._-]' then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- No fabricated attribution for old pending challenges or old accounts.
alter table email_registrations add column landing_attribution jsonb
  check (citygo_valid_landing_attribution(landing_attribution));

create function citygo_guard_registration_attribution() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if new.landing_attribution is distinct from old.landing_attribution then
    raise exception 'Registration acquisition snapshot is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger email_registration_attribution_identity before update on email_registrations
  for each row execute function citygo_guard_registration_attribution();

create table user_acquisition (
  user_id bigint primary key references users(id) on delete cascade,
  landing_attribution jsonb check (citygo_valid_landing_attribution(landing_attribution)),
  created_at timestamptz not null default clock_timestamp()
);

create function citygo_guard_user_acquisition() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
  if TG_OP='UPDATE' then
    raise exception 'Account acquisition is immutable' using errcode='23514';
  end if;
  -- A late analytics event/login cannot label an existing account. The API
  -- inserts only after users INSERT in this same creation transaction. The
  -- timestamp test also excludes a merely updated old users row.
  if not exists (select 1 from public.users u where u.id=new.user_id
    and u.created_at=transaction_timestamp()
    and u.xmin::text::bigint=mod(txid_current(),4294967296)) then
    raise exception 'Acquisition must accompany account creation' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger user_acquisition_identity before insert or update on user_acquisition
  for each row execute function citygo_guard_user_acquisition();

revoke all on function citygo_valid_landing_attribution(jsonb) from public;
revoke all on function citygo_guard_registration_attribution() from public;
revoke all on function citygo_guard_user_acquisition() from public;
commit;
