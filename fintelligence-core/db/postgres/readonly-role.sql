-- Provision the read-only warehouse role.
--
--   psql -d fintel -v reader_password="'...'" -f db/postgres/readonly-role.sql
--
-- The password is a psql variable and is NOT stored in this file. A committed
-- placeholder credential is the line a reviewer grepping for secrets lands on,
-- and "it's only a template" is an argument you have to make every time.
--
-- Two things here are less obvious than they look:
--
-- 1. No DROP ROLE. Roles are cluster-wide, so DROP ROLE fails if the role
--    holds a privilege in ANY other database in the cluster — and psql, absent
--    ON_ERROR_STOP, keeps going. Every statement after it then "succeeds"
--    against a role that still carries its old password and old grants, and
--    the script reports success. Create-if-absent plus ALTER is idempotent and
--    cannot half-apply that way.
--
-- 2. ON_ERROR_STOP is set. Without it this script reports success after
--    failing partway, which for a security boundary is worse than failing.

\set ON_ERROR_STOP on

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fintel_reader') THEN
        CREATE ROLE fintel_reader LOGIN;
    END IF;
END
$$;

ALTER ROLE fintel_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
    PASSWORD :reader_password;

-- Connect and read. Nothing else.
GRANT CONNECT ON DATABASE fintel TO fintel_reader;
GRANT USAGE ON SCHEMA public TO fintel_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fintel_reader;

-- CREATE on the public schema is granted to PUBLIC by default before
-- PostgreSQL 15, and a role that can create tables in the schema it queries is
-- not read-only in any sense an auditor would accept.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM fintel_reader;

-- Grants attach to table OBJECTS, not to names. Re-running the mirror drops
-- and recreates the tables, which silently revokes everything granted above:
-- the new table is a different object that happens to share a name. Default
-- privileges cover tables created LATER by the mirror's role, so the two
-- setup steps commute and the order they are run in stops mattering.
ALTER DEFAULT PRIVILEGES FOR ROLE fintel_admin IN SCHEMA public
    GRANT SELECT ON TABLES TO fintel_reader;
