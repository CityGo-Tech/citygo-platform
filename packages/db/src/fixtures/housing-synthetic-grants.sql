-- Test fixture ONLY, not shipped/applied by migrate, release or deploy.
-- Tests replace this role with a generated isolated no-login role.
grant select, insert on r1_housing_briefs, r1_housing_commands,
  r1_housing_brief_revisions to cg012_synthetic_api;
grant usage on sequence r1_housing_briefs_id_seq to cg012_synthetic_api;
-- Existing API already needs SELECT/UPDATE on users and relocation_plans for locks.
-- No UPDATE/DELETE/TRUNCATE on R1, no worker access, no sequence UPDATE.
