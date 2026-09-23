#!/bin/sh
# Emits a sensitive custom-format dump to stdout, NEVER to logs/terminal.
# Use deploy/backup/backup.py for encryption/verified upload after launch approval.
# This low-level producer is not a complete backup service on its own.
set -eu
umask 077
PGPASSWORD="$(cat /run/secrets/db_backup_password)"
export PGPASSWORD
if ! pg_dump --host=postgres --username=citygo_backup --dbname=citygo_pilot \
  --format=custom --no-owner --no-acl --lock-wait-timeout=5s 2>/tmp/dump-error; then
  echo 'CityGo dump failed; discard partial output and check protected diagnostics' >&2
  exit 1
fi
