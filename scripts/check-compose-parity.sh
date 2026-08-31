#!/bin/sh
# Asserts that the two release compose files differ ONLY in the Whisper service.
#
# WHY THIS EXISTS: docker-compose.release.yml and docker-compose.release-gpu.yml are deliberate
# duplicates — an operator picks one file and reads it top to bottom, instead of reasoning about
# which overlays to chain. That choice is only defensible while the two files actually stay in
# step, and nothing about copying a file makes that happen. A published port added to one and not
# the other, a hardening flag dropped from one, a service that exists in only one: all of those
# are silent, and all of them are exactly the kind of thing a reviewer catches by luck or not at
# all. This check is what makes the duplication safe rather than merely convenient.
#
# HOW IT COMPARES: through `docker compose config`, not by diffing text. That renders each file to
# its normalized, fully interpolated form, so the comparison is of what Compose will actually do —
# comments, key order and formatting cannot cause a false failure, and none of them can hide a
# real difference either.
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
CPU="$ROOT/docker-compose.release.yml"
GPU="$ROOT/docker-compose.release-gpu.yml"

for tool in docker jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "error: $tool is required" >&2
    exit 1
  }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Interpolation needs values; they only have to be present and identical for both renders, so
# they are deliberately fake. Nothing here is a secret or reaches a container.
cat > "$TMP/env" <<'EOF'
QUORUM_PUBLIC_URL=https://parity.invalid
KEYCLOAK_PUBLIC_URL=https://parity.invalid
POSTGRES_USER=parity
POSTGRES_DB=parity
POSTGRES_PASSWORD=parityparityparityparity
KEYCLOAK_DB_PASSWORD=parityparityparityparity
KEYCLOAK_ADMIN_PASSWORD=parityparityparityparity
KEYCLOAK_PROVISIONER_SECRET=parityparityparityparity
MINIO_ROOT_USER=parity
MINIO_ROOT_PASSWORD=parityparityparityparity
MINIO_KMS_SECRET_KEY=parity-key:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
S3_BUCKET=parity
SUMMARY_BASE_URL=https://parity.invalid/v1
SUMMARY_API_KEY=parityparityparityparity
SUMMARY_MODEL=parity/model
WHISPER_MODEL=parity
WHISPER_COMPUTE_TYPE=int8
WHISPER_DEVICE=cpu
WHISPER_IMAGE_TAG=parity
GRAFANA_ADMIN_PASSWORD=parityparityparityparity
EOF

# `whisper` is the one service allowed to differ: the GPU file reserves an NVIDIA device for it.
# Everything else — every service, port, volume, capability and healthcheck — must match.
render() {
  docker compose -f "$1" --env-file "$TMP/env" --profile monitoring config --format json \
    | jq -S 'del(.services.whisper)'
}

render "$CPU" > "$TMP/cpu.json"
render "$GPU" > "$TMP/gpu.json"

if diff -u "$TMP/cpu.json" "$TMP/gpu.json" > "$TMP/diff"; then
  echo "compose parity OK — the two release files differ only in the whisper service"
  exit 0
fi

echo "COMPOSE PARITY FAILED" >&2
echo >&2
echo "docker-compose.release.yml and docker-compose.release-gpu.yml differ outside the whisper" >&2
echo "service. They are meant to be identical apart from GPU access, so one of them has drifted." >&2
echo "Apply the change to both files." >&2
echo >&2
echo "--- docker-compose.release.yml (CPU)   +++ docker-compose.release-gpu.yml (GPU)" >&2
sed -n '3,$p' "$TMP/diff" >&2
exit 1
