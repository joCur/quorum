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

mc alias set quorum "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "quorum/${S3_BUCKET}"
# Default SSE-S3 encryption for every object written to the bucket.
mc encrypt set sse-s3 "quorum/${S3_BUCKET}"
mc encrypt info "quorum/${S3_BUCKET}"
