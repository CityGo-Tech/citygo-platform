begin;

-- CG-011A snapshots are independent of the legacy knowledge_sources table.
-- Publication changes append a revision; runtime roles cannot rewrite history.
create table knowledge_editorial_revisions (
  kind text not null check (kind in ('source','fact')),
  id text not null check (id ~ '^[a-z0-9][a-z0-9._:-]{0,119}$'),
  revision bigint not null check (revision between 1 and 9007199254740991),
  fact_key text,
  scope jsonb not null,
  state text not null check (state in ('candidate','published','stale','withdrawn')),
  document jsonb not null,
  occurred_at timestamptz not null,
  primary key (kind,id,revision),
  check (jsonb_typeof(scope) = 'object'),
  check (
    (kind = 'source' and fact_key is null and not (document ? 'factKey'))
    or (kind = 'fact' and fact_key is not null
      and fact_key ~ '^[a-z0-9][a-z0-9._:-]{0,119}$'
      and (document ->> 'factKey') is not distinct from fact_key)
  ),
  check (coalesce(
    jsonb_typeof(document) = 'object'
      and document ->> 'id' = id
      and document -> 'revision' = to_jsonb(revision)
      and document -> 'scope' = scope
      and document #>> '{publication,status}' =
        case when state = 'stale' then 'published' else state end,
    false
  ))
);

-- One identity per editorial question and exact city/route/global scope.
create unique index knowledge_editorial_first_fact_idx
  on knowledge_editorial_revisions (fact_key,scope)
  where kind = 'fact' and revision = 1;
create index knowledge_editorial_fact_lookup_idx
  on knowledge_editorial_revisions (fact_key,scope,revision desc)
  where kind = 'fact';

commit;
