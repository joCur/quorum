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

# How long EACH step below tolerates a MinIO that is running but not yet serving.
#
# WHY IT RETRIES AT ALL: healthy is not the same as ready. The healthcheck polls
# /minio/health/live, and MinIO answers that before it accepts bucket and admin calls. On a busy
# machine — a CI runner bringing six containers up at once — the gap between the two is a second
# or so, and until now the first refusal in that gap failed this service. That takes the whole
# stack down with it, because the API and the worker both wait for this one to complete
# successfully. It reads as a broken stack when nothing is broken.
#
# WHY THE WINDOW IS BOUNDED: a wrong password, a bucket name the server rejects or an endpoint
# pointing at nothing are indistinguishable from a slow start for as long as anyone is prepared to
# wait. A minute is far more than the readiness gap ever needs and short enough that a genuinely
# misconfigured stack is still an error within the minute.
#
# WHY THE WINDOW IS PER STEP AND NOT SHARED: a single window across all four steps would let a slow
# first step spend it, leaving the second to fail on one unlucky attempt — and then be reported as
# a configuration error, which is precisely the misdiagnosis this whole file exists to prevent.
# Every step therefore starts its window fresh, and none of them gives up before
# MINIMUM_ATTEMPTS tries, so "it failed every time" is always a statement about several attempts.
RETRY_WINDOW_SECONDS="${MINIO_INIT_RETRY_WINDOW_SECONDS:-60}"
MINIMUM_ATTEMPTS=3

# Runs a command until it succeeds, or until its window has closed and it has had its minimum
# number of tries. Every failed attempt is reported as it happens — see below for why.
retry() {
  what="$1"
  shift
  attempt=1
  delay=1
  deadline=$(($(date +%s) + RETRY_WINDOW_SECONDS))
  while :; do
    if output="$("$@" 2>&1)"; then
      [ -z "$output" ] || echo "$output"
      [ "$attempt" -eq 1 ] || echo "minio-init: ${what} — succeeded on attempt ${attempt}"
      return 0
    fi
    # Printed now rather than held back for a summary at the end. Two reasons, both learned the
    # hard way: a container killed mid-window — a teardown, a cancelled CI run — would otherwise
    # leave a log of "retrying" lines and no cause at all; and the FIRST failure is usually the
    # true one, while the last can easily be a "connection refused" from a server already on its
    # way down. Keeping every attempt costs a few noisy lines on a run that then succeeds, which
    # is a good trade for never having to guess.
    echo "minio-init: ${what} — attempt ${attempt} failed:" >&2
    echo "$output" >&2
    if [ "$attempt" -ge "$MINIMUM_ATTEMPTS" ] && [ "$(date +%s)" -ge "$deadline" ]; then
      echo "minio-init: ${what} — giving up: ${attempt} attempts over ${RETRY_WINDOW_SECONDS}s, all failed." >&2
      echo "minio-init: the window for a slow start has closed, so read the failures above as the" >&2
      echo "minio-init: configuration (MINIO_ENDPOINT, the root credentials, the bucket name) and" >&2
      echo "minio-init: not the timing — or raise MINIO_INIT_RETRY_WINDOW_SECONDS if this machine" >&2
      echo "minio-init: really is that slow." >&2
      case "$output" in
        *"flag provided but not defined"*)
          echo "minio-init: that particular error is a value being parsed as a command-line flag," >&2
          echo "minio-init: not a rejected credential — check whether MINIO_ROOT_USER," >&2
          echo "minio-init: MINIO_ROOT_PASSWORD or S3_BUCKET begins with '-'." >&2
          ;;
      esac
      return 1
    fi
    echo "minio-init: ${what} — retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
    [ "$delay" -le 5 ] || delay=5
  done
}

# `--` ends mc's own flag parsing: without it a credential that happens to begin with "-" is read
# as a flag ("flag provided but not defined"), which no amount of retrying can survive.
retry "reaching MinIO at ${MINIO_ENDPOINT}" \
  mc alias set -- quorum "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
retry "creating the '${S3_BUCKET}' bucket" \
  mc mb --ignore-existing "quorum/${S3_BUCKET}"
# Default SSE-S3 encryption for every object written to the bucket.
retry "enabling default sse-s3 encryption on '${S3_BUCKET}'" \
  mc encrypt set sse-s3 "quorum/${S3_BUCKET}"
retry "reading back the encryption setting" \
  mc encrypt info "quorum/${S3_BUCKET}"
