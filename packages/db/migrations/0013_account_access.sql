begin;

-- Application roles are unrelated to PostgreSQL login roles. Existing accounts
-- remain ordinary users; an operational allowlist is not silently promoted.
alter table users
  add column username text unique,
  add column role text not null default 'user'
    check (role in ('user', 'admin', 'super_admin')),
  add column must_change_password boolean not null default false,
  add constraint users_username_format check (
    username is null or (
      username = lower(username) and username = btrim(username)
      and char_length(username) between 1 and 64
      and position('@' in username) = 0
    )
  );

-- Shared lock ordering: this row first, then users in numeric ID order.
-- The persistent flag prevents recreating a known bootstrap password after a
-- restart, account deletion or any later cleanup. No account is seeded here.
create table account_security_state (
  id smallint primary key check (id = 1),
  bootstrap_completed boolean not null default false
);
insert into account_security_state(id) values (1);

commit;
