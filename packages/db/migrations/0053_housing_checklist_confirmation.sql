begin;

alter table housing_workspace_checklists
  add column confirmed_from_revision int,
  add constraint housing_workspace_checklists_confirmation_revision
    check (confirmed_from_revision = revision - 1),
  add constraint housing_workspace_checklists_confirmation_source
    foreign key (user_id,confirmed_from_revision)
    references housing_workspace_checklists(user_id,revision);

commit;
