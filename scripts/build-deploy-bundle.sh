#!/bin/sh
# Packages everything a deployment needs, and nothing else, into one versioned archive.
#
# WHY THIS EXISTS: a deployment needs about a dozen files. Cloning the repository to get them puts
# the whole source tree, the test suites and the development compose files on a production host,
# and leaves git as a dependency of the deploy. It also invites the failure this is really about:
# a host whose checkout has drifted from the images it is running, with nothing to notice.
#
# The bundle removes both. It carries its own version, and that version is what pins the image
# tags, so the artifact and the images it was released with cannot come apart.
#
# WHY THE DIRECTORY LAYOUT IS MIRRORED RATHER THAN FLATTENED: docker-compose.release.yml mounts
# ./scripts/*.sh and ./infra/**. Reproducing those paths inside the bundle means the compose file
# is copied in unmodified and behaves identically whether it is run from a checkout or from an
# unpacked bundle — there is no second, subtly different copy to keep in step.
#
# USAGE:
#   ./scripts/build-deploy-bundle.sh <version> [output-directory]
#
# Produces <output-directory>/quorum-deploy-<version>.tar.gz. The release workflow runs this and
# attaches the result to the GitHub release.
set -eu

VERSION="${1:-}"
OUT_DIR="${2:-dist}"

if [ -z "$VERSION" ]; then
  echo "usage: $0 <version> [output-directory]" >&2
  echo "example: $0 1.0.0" >&2
  exit 1
fi

REPO_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$REPO_ROOT"

NAME="quorum-deploy-${VERSION}"
STAGE="$(mktemp -d)"
BUNDLE="${STAGE}/${NAME}"

# Everything the deployment actually reads, plus the runbooks an operator needs at three in the
# morning. Listed explicitly rather than by wildcard: a new file should have to be added here
# deliberately, so that nothing lands on a production host because a glob widened.
#
# The paths are preserved inside the bundle, which matters for two independent reasons: the
# compose file mounts ./scripts and ./infra by those exact paths, and the guide's references to
# docs/runbooks/*.md then resolve the same way whether it is read in the repository or unpacked
# on a host.
FILES="
docker-compose.release.yml
docker-compose.gpu.yml
scripts/secrets-preflight.sh
scripts/kms-preflight.sh
scripts/minio-init.sh
infra/keycloak/realm-production.json
infra/edge/nginx.conf.template
infra/edge/proxy-headers.conf
infra/postgres/init
infra/monitoring/prometheus.yml
infra/monitoring/alertmanager.yml
infra/monitoring/rules
infra/monitoring/grafana/provisioning
infra/monitoring/grafana/dashboards
docs/runbooks
docs/observability.md
"

mkdir -p "$BUNDLE"

for path in $FILES; do
  if [ ! -e "$path" ]; then
    echo "error: $path is referenced by the bundle but does not exist" >&2
    exit 1
  fi
  mkdir -p "$BUNDLE/$(dirname "$path")"
  cp -R "$path" "$BUNDLE/$(dirname "$path")/"
done

# The deployment guide travels with the bundle, so the instructions on the host are the ones for
# the version on the host.
cp docs/deployment.md "$BUNDLE/DEPLOYMENT.md"

# The env template, with the version stamped in and active. This is the pinning: unpacking the
# 1.2.0 bundle gives an .env that runs the 1.2.0 images, with no step where someone has to
# remember to set it.
sed "s|^# QUORUM_VERSION=.*|QUORUM_VERSION=${VERSION}|" .env.example > "$BUNDLE/.env.example"

if ! grep -q "^QUORUM_VERSION=${VERSION}$" "$BUNDLE/.env.example"; then
  echo "error: could not stamp QUORUM_VERSION into .env.example" >&2
  echo "The '# QUORUM_VERSION=' line in .env.example has changed shape; fix this script." >&2
  exit 1
fi

echo "$VERSION" > "$BUNDLE/VERSION"

cat > "$BUNDLE/README.md" <<EOF
# Quorum deployment bundle ${VERSION}

Everything needed to run Quorum ${VERSION}, and nothing else. There is no source code here and
no git checkout is required.

    cp .env.example .env      # then fill in the mandatory values
    chmod 600 .env
    docker compose -f docker-compose.release.yml up -d --wait

Full instructions are in DEPLOYMENT.md. The stack refuses to start until every mandatory value is
set, and tells you which ones are missing.

\`.env.example\` already pins \`QUORUM_VERSION=${VERSION}\`, which is the version of the images this
bundle was released with. To upgrade, download the next bundle rather than editing that value —
the compose file, the realm and the scripts are versioned along with the images.
EOF

mkdir -p "$OUT_DIR"
OUT_DIR_ABS="$(CDPATH='' cd -- "$OUT_DIR" && pwd)"
tar -czf "${OUT_DIR_ABS}/${NAME}.tar.gz" -C "$STAGE" "$NAME"
rm -rf "$STAGE"

echo "${OUT_DIR_ABS}/${NAME}.tar.gz"
