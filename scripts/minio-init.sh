#!/bin/sh
# Bucket bootstrap for the recording storage (ADR-001, ADR-006 §5).
#
# Creates the recordings bucket and enables DEFAULT server-side encryption on it,
# so an object cannot be written unencrypted even if a client forgets to ask for
# it. Runs as the `minio-init` one-shot service in docker-compose.yml.
#
# Key management (SSE-S3 with MinIO's built-in KMS vs. SSE-KMS via KES) is an
# infra ticket; SSE-S3 is the default here because it needs no extra service.
set -eu

: "${S3_BUCKET:?S3_BUCKET must be set}"
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER must be set}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD must be set}"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://minio:9000}"

# How long this bootstrap tolerates a MinIO that is running but not yet serving.
#
# WHY IT RETRIES AT ALL: healthy is not the same as ready. The healthcheck polls
# /minio/health/live, and MinIO answers that before it accepts bucket and admin calls. On a busy
# machine — a CI runner bringing six containers up at once — the gap between the two is a second
# or so, and until now the first refusal in that gap failed this service. That takes the whole
# stack down with it, because the API and the worker both wait for this one to complete
# successfully. It reads as a broken stack when nothing is broken.
#
# WHY THE WINDOW IS BOUNDED, AND SHARED BY ALL THE COMMANDS BELOW: a wrong password, a bucket name
# the server rejects or an endpoint pointing at nothing are indistinguishable from a slow start for
# as long as anyone is prepared to wait. One minute is far more than the readiness gap ever needs
# and short enough that a genuinely misconfigured stack is still an error within the minute, with
# the server's own last words printed underneath it rather than a bare timeout.
RETRY_WINDOW_SECONDS="${MINIO_INIT_RETRY_WINDOW_SECONDS:-60}"
DEADLINE=$(($(date +%s) + RETRY_WINDOW_SECONDS))

# Runs a command until it succeeds or the window closes. Output is held back while it is retrying
# so a transient refusal does not read like a failure, and printed in full when one finally is.
retry() {
  what="$1"
  shift
  attempt=1
  delay=1
  while :; do
    if output="$("$@" 2>&1)"; then
      [ -z "$output" ] || echo "$output"
      [ "$attempt" -eq 1 ] || echo "minio-init: ${what} — succeeded on attempt ${attempt}"
      return 0
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      echo "minio-init: ${what} — still failing after ${attempt} attempts over ${RETRY_WINDOW_SECONDS}s." >&2
      echo "minio-init: that is far longer than a slow start takes, so this is the configuration" >&2
      echo "minio-init: (MINIO_ENDPOINT, the root credentials, the bucket name) and not the timing." >&2
      echo "minio-init: The last attempt said:" >&2
      echo "$output" >&2
      return 1
    fi
    echo "minio-init: ${what} — attempt ${attempt} failed, retrying in ${delay}s"
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
    [ "$delay" -le 5 ] || delay=5
  done
}

retry "reaching MinIO at ${MINIO_ENDPOINT}" \
  mc alias set quorum "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
retry "creating the '${S3_BUCKET}' bucket" \
  mc mb --ignore-existing "quorum/${S3_BUCKET}"
# Default SSE-S3 encryption for every object written to the bucket.
retry "enabling default sse-s3 encryption on '${S3_BUCKET}'" \
  mc encrypt set sse-s3 "quorum/${S3_BUCKET}"
retry "reading back the encryption setting" \
  mc encrypt info "quorum/${S3_BUCKET}"
