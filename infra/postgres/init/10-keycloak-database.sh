#!/bin/sh
# Provisions the Keycloak database on the shared Postgres instance (ADR-006 §7:
# Keycloak gets its own logical database and user, not its own container).
#
# The official Postgres image runs everything in /docker-entrypoint-initdb.d exactly once, on an
# empty data directory. If you add this script to a stack whose pg-data volume already exists, run
# the two statements below by hand or recreate the volume (`docker compose down -v`).
set -eu

: "${KEYCLOAK_DB_NAME:=keycloak}"
: "${KEYCLOAK_DB_USER:=keycloak}"
: "${KEYCLOAK_DB_PASSWORD:?KEYCLOAK_DB_PASSWORD must be set for the postgres service}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE ROLE "${KEYCLOAK_DB_USER}" WITH LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}';
	CREATE DATABASE "${KEYCLOAK_DB_NAME}" OWNER "${KEYCLOAK_DB_USER}";
	REVOKE ALL ON DATABASE "${KEYCLOAK_DB_NAME}" FROM PUBLIC;
	GRANT ALL PRIVILEGES ON DATABASE "${KEYCLOAK_DB_NAME}" TO "${KEYCLOAK_DB_USER}";
EOSQL

echo "keycloak database '${KEYCLOAK_DB_NAME}' and role '${KEYCLOAK_DB_USER}' created"
