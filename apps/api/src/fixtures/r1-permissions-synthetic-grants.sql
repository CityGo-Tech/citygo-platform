-- Disposable test fixture ONLY, never applied by deploy/migrate.
-- The test harness replaces this exact placeholder with its new NOLOGIN role.
grant usage on schema cg018_synthetic to cg018_synthetic_http;
grant select on all tables in schema cg018_synthetic to cg018_synthetic_http;
grant insert (owner_id,scope,request_id,fingerprint,command,event_id,result_revision,configuration_revision)
  on cg018_synthetic.commands to cg018_synthetic_http;
grant insert on cg018_synthetic.decisions to cg018_synthetic_http;
grant update (revision,event_id) on cg018_synthetic.decisions to cg018_synthetic_http;
-- SELECT FOR UPDATE requires UPDATE on at least one column. Do not grant
-- UPDATE on the mode, configuration pointer or route high-water mark.
grant update (id) on cg018_synthetic.runtime to cg018_synthetic_http;
