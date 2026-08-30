#!/bin/sh
# Preflight validation for MinIO's KMS master key.
#
# WHY THIS EXISTS: a malformed MINIO_KMS_SECRET_KEY kills MinIO at startup with an error that
# never names the variable, and because the API, the worker and the bucket bootstrap all wait on
# a healthy MinIO, the whole stack fails to come up behind one unreadable message. That is a
# genuinely expensive twenty minutes for anyone meeting the project for the first time.
#
# WHY IT RUNS BEFORE MINIO AND NOT IN minio-init: the bucket bootstrap only starts once MinIO is
# healthy, so it could never see this failure — MinIO is already dead by then. This is a one-shot
# gate that MinIO itself depends on.
#
# The check is deliberately narrow: it validates the FORMAT of the key, not whether it is the same
# key the existing data was encrypted with. Nothing at startup can tell those apart, which is why
# the key backup procedure in docs/runbooks/backup-restore.md is not optional.
set -eu

FAIL() {
  echo "MINIO_KMS_SECRET_KEY preflight FAILED: $1" >&2
  echo >&2
  echo "Expected format: <key-name>:<base64 of exactly 32 random bytes>" >&2
  echo "Generate one with:" >&2
  echo "  echo \"quorum-key:\$(openssl rand -base64 32)\"" >&2
  echo >&2
  echo "WARNING: on a stack that already holds recordings, replacing this key makes the stored" >&2
  echo "audio permanently unreadable. See docs/runbooks/backup-restore.md." >&2
  exit 1
}

KEY="${MINIO_KMS_SECRET_KEY:-}"

[ -n "$KEY" ] || FAIL "the variable is empty or unset"

case "$KEY" in
  *:*) ;;
  *) FAIL "no ':' separator — the key name is missing" ;;
esac

NAME="${KEY%%:*}"
SECRET="${KEY#*:}"

[ -n "$NAME" ] || FAIL "the key name before ':' is empty"
[ -n "$SECRET" ] || FAIL "the secret after ':' is empty"

# One colon only: MinIO splits on the first, so a second one silently becomes part of the base64
# and produces a decode failure with no explanation.
case "$SECRET" in
  *:*) FAIL "more than one ':' — the key name must not contain a colon" ;;
esac

# MinIO requires exactly 32 bytes after base64 decoding. Both halves of this matter: a value that
# is not valid base64 at all, and a valid base64 value of the wrong length, fail identically at
# MinIO startup and for different reasons.
#
# The length is reported rather than the validity, because busybox's base64 decodes what it can
# from a malformed value instead of refusing it — so "wrong length" is the honest description of
# both cases, and 32 is the only answer that passes either way.
DECODED_BYTES=$(printf '%s' "$SECRET" | base64 -d 2>/dev/null | wc -c | tr -d ' ')

if [ -z "$DECODED_BYTES" ] || [ "$DECODED_BYTES" -ne 32 ]; then
  FAIL "the secret decodes to ${DECODED_BYTES:-0} bytes; MinIO requires exactly 32 (check that it is valid base64 of 32 random bytes)"
fi

# The key name is echoed on purpose and the secret never is: the name is what a restore has to
# match, and seeing it confirmed at startup is worth one line of log.
echo "MINIO_KMS_SECRET_KEY preflight OK (key name: ${NAME}, 32 bytes)"
