#!/bin/sh
# Bootstrap for the release stack, in three phases.
#
# WHY ONE IMAGE: everything this does used to be a script or a config file mounted from a git
# checkout on the deploy host. That is what forced a deployment to carry the repository around.
# Baked into a versioned image instead, the bootstrap travels with the release it belongs to —
# including the production realm, so the realm and the images that trust it can never be a
# version apart.
#
# WHY THREE PHASES AND NOT ONE RUN: the phases are separated by things that have to happen in
# between, and no amount of wishing collapses them.
#
#   preflight  — before anything else starts. The KMS key check in particular has to run BEFORE
#                MinIO, because a malformed key kills MinIO at startup with an error that never
#                names the variable. Checking it afterwards would mean checking a corpse.
#   bootstrap  — after Postgres and MinIO are healthy, before Keycloak starts: Keycloak's
#                database has to exist before Keycloak can migrate into it, and the recordings
#                bucket has to exist before the first chunk is written.
#   realm      — after Keycloak is healthy, before the API starts: the API validates tokens
#                against this realm, so starting before it is applied means rejecting logins.
#
# All three are idempotent and run on every deploy.
set -eu

PHASE="${1:-}"

log() { echo "[quorum-init:${PHASE}] $*"; }

# ---------------------------------------------------------------------------------------------
wait_for() {
  what="$1"
  shift
  attempts=60
  while [ "$attempts" -gt 0 ]; do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 2
  done
  log "giving up waiting for ${what}"
  return 1
}

# ---------------------------------------------------------------------------------------------
phase_preflight() {
  log "validating configuration"
  /opt/quorum/secrets-preflight.sh
  /opt/quorum/kms-preflight.sh
  log "configuration OK"
}

# ---------------------------------------------------------------------------------------------
# Keycloak's own logical database on the shared Postgres instance (ADR-006 §7). Written as
# check-then-create rather than the dev stack's plain CREATE, because that one runs exactly once
# on an empty data directory and this one runs on every deploy. CREATE DATABASE cannot appear in
# a DO block, which is why the existence check is a separate query rather than IF NOT EXISTS.
phase_keycloak_database() {
  KEYCLOAK_DB_NAME="${KEYCLOAK_DB_NAME:-keycloak}"
  KEYCLOAK_DB_USER="${KEYCLOAK_DB_USER:-keycloak}"
  : "${KEYCLOAK_DB_PASSWORD:?KEYCLOAK_DB_PASSWORD must be set}"

  export PGPASSWORD="$POSTGRES_PASSWORD"
  PSQL="psql -v ON_ERROR_STOP=1 --host=${POSTGRES_HOST:-postgres} --port=${POSTGRES_PORT:-5432} --username=${POSTGRES_USER} --dbname=${POSTGRES_DB}"

  wait_for "postgres" $PSQL -c "SELECT 1"

  role_exists=$($PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${KEYCLOAK_DB_USER}'")
  if [ "$role_exists" = "1" ]; then
    # The password is re-applied rather than left alone, so rotating it in .env is enough.
    $PSQL -c "ALTER ROLE \"${KEYCLOAK_DB_USER}\" WITH LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}'" >/dev/null
    log "keycloak role '${KEYCLOAK_DB_USER}' already present, password reapplied"
  else
    $PSQL -c "CREATE ROLE \"${KEYCLOAK_DB_USER}\" WITH LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}'" >/dev/null
    log "keycloak role '${KEYCLOAK_DB_USER}' created"
  fi

  db_exists=$($PSQL -tAc "SELECT 1 FROM pg_database WHERE datname = '${KEYCLOAK_DB_NAME}'")
  if [ "$db_exists" = "1" ]; then
    log "keycloak database '${KEYCLOAK_DB_NAME}' already present"
  else
    $PSQL -c "CREATE DATABASE \"${KEYCLOAK_DB_NAME}\" OWNER \"${KEYCLOAK_DB_USER}\"" >/dev/null
    log "keycloak database '${KEYCLOAK_DB_NAME}' created"
  fi

  $PSQL -c "REVOKE ALL ON DATABASE \"${KEYCLOAK_DB_NAME}\" FROM PUBLIC" >/dev/null
  $PSQL -c "GRANT ALL PRIVILEGES ON DATABASE \"${KEYCLOAK_DB_NAME}\" TO \"${KEYCLOAK_DB_USER}\"" >/dev/null
  unset PGPASSWORD
}

# ---------------------------------------------------------------------------------------------
# The recordings bucket with default server-side encryption, so an object cannot be written
# unencrypted even if a client forgets to ask for it (ADR-001).
phase_storage() {
  : "${S3_BUCKET:?S3_BUCKET must be set}"
  : "${MINIO_ROOT_USER:?MINIO_ROOT_USER must be set}"
  : "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD must be set}"
  MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"

  # mc writes its configuration under $HOME by default, which a read-only container refuses.
  export MC_CONFIG_DIR=/tmp/mc

  # `--` ends mc's own flag parsing. Without it an operator's password that begins with "-" is
  # read as a flag, and the retry above then spends its whole budget on an error that no wait can
  # fix while pointing at MinIO rather than at the credential.
  wait_for "minio" mc alias set -- quorum "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
  mc mb --ignore-existing "quorum/${S3_BUCKET}"
  mc encrypt set sse-s3 "quorum/${S3_BUCKET}"
  log "bucket '${S3_BUCKET}' ready with default sse-s3 encryption"
}

# ---------------------------------------------------------------------------------------------
# The production realm, applied declaratively. The file is baked into this image, so the realm a
# release expects arrives with that release rather than being fetched or mounted.
#
# The two settings that carry the weight are set here rather than left to their defaults:
#
#   IMPORT_CACHE_ENABLED=false — the tool otherwise stores a checksum of the file it imported and
#     skips the run when the file has not changed, which would leave a setting changed by hand in
#     the admin console in place indefinitely. Drift revert is the whole point, so the cache goes.
#   IMPORT_MANAGED_USER=no-delete — under the default, everything absent from the file is deleted
#     from the realm, users included. That would wipe every account on every deploy.
phase_realm() {
  : "${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD must be set}"
  : "${QUORUM_PUBLIC_URL:?QUORUM_PUBLIC_URL must be set}"

  export KEYCLOAK_URL="${KEYCLOAK_INTERNAL_URL:-http://keycloak:8080}"
  export KEYCLOAK_USER="${KEYCLOAK_ADMIN:-admin}"
  export KEYCLOAK_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD"
  export KEYCLOAK_AVAILABILITYCHECK_ENABLED=true
  export KEYCLOAK_AVAILABILITYCHECK_TIMEOUT=120s
  export IMPORT_FILES_LOCATIONS=/opt/quorum/realm-production.json
  export IMPORT_VARSUBSTITUTION_ENABLED=true
  export IMPORT_CACHE_ENABLED=false
  export IMPORT_MANAGED_USER=no-delete

  log "applying the production realm"
  exec java -jar /app/keycloak-config-cli.jar
}

# ---------------------------------------------------------------------------------------------
case "$PHASE" in
  preflight)
    phase_preflight
    ;;
  bootstrap)
    phase_keycloak_database
    phase_storage
    log "bootstrap complete"
    ;;
  realm)
    phase_realm
    ;;
  check)
    # Validate just the named variables as credentials. The monitoring profile uses this for its
    # one secret, which cannot live in the main preflight: Compose interpolates every service in
    # the file regardless of profile, so a mandatory monitoring variable would block a stack that
    # never enables monitoring.
    shift
    [ "$#" -gt 0 ] || { echo "usage: quorum-init check <VAR> [VAR...]" >&2; exit 1; }
    /opt/quorum/secrets-preflight.sh "$@"
    ;;
  *)
    echo "usage: quorum-init <preflight|bootstrap|realm|check VAR...>" >&2
    exit 1
    ;;
esac
