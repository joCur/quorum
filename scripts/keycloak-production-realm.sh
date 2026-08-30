#!/bin/sh
# Derives a production realm definition from the committed development realm.
#
# WHY THIS IS A SCRIPT AND NOT A SECOND COMMITTED JSON FILE: a hand-maintained production copy of
# realm-quorum.json drifts. Someone adds a protocol mapper, a role or a session setting to the
# development realm — reviewed as a diff, exactly as intended — and the production copy quietly
# keeps the old shape until a login fails in a way nobody connects to a realm edit six weeks
# earlier. Deriving the file means the two can only differ in the ways listed below.
#
# WHAT IT CHANGES, and nothing else:
#   1. sslRequired: none -> external. The development value exists because the compose port proxy
#      makes Keycloak see a bridge gateway as an external address over plain HTTP; anywhere else
#      it means passwords and tokens in clear text. See infra/keycloak/README.md.
#   2. Drops the quorum-dev-cli client — a password-grant client, which exists so a developer can
#      fetch a token with one curl.
#   3. Drops the dev.alice / dev.bob / dev.carol users and their committed passwords.
#   4. Replaces the localhost redirect URIs and web origins of quorum-pwa with the public origin.
#
# Everything else — the session lifetimes, the refresh token rotation, the audience and tenant
# mappers, the realm roles, the declared tenant_id user profile attribute — is carried over
# unchanged, because those are deliberate decisions rather than development conveniences.
#
# USAGE:
#   ./scripts/keycloak-production-realm.sh https://quorum.example.com > realm-production.json
#
# The output is imported once, through the admin console or `kc.sh import`. It is NOT mounted
# into the release stack: docker-compose.release.yml has no import mount on purpose, so a realm
# can never be silently reset by a container restart. See docs/deployment.md.
set -eu

PUBLIC_URL="${1:-}"

if [ -z "$PUBLIC_URL" ]; then
  echo "usage: $0 <public-app-origin>" >&2
  echo "example: $0 https://quorum.example.com" >&2
  exit 1
fi

case "$PUBLIC_URL" in
  https://*) ;;
  *)
    echo "error: the public origin must be an https:// URL (got: $PUBLIC_URL)" >&2
    echo "Production runs behind a TLS-terminating reverse proxy; an http origin here would" >&2
    echo "produce redirect URIs that sslRequired=external then refuses." >&2
    exit 1
    ;;
esac

# A trailing slash would produce "https://host//*" in the redirect URI, which does not match.
PUBLIC_URL="${PUBLIC_URL%/}"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (apt install jq / brew install jq)" >&2
  exit 1
fi

SOURCE="$(dirname "$0")/../infra/keycloak/realm-quorum.json"

if [ ! -f "$SOURCE" ]; then
  echo "error: development realm not found at $SOURCE" >&2
  exit 1
fi

jq --arg origin "$PUBLIC_URL" '
  .sslRequired = "external"
  # The development-only client and users, removed by name rather than by position.
  | .clients = [.clients[] | select(.clientId != "quorum-dev-cli")]
  | del(.users)
  | .clients = [
      .clients[]
      | if .clientId == "quorum-pwa"
        then .redirectUris = [$origin + "/*"] | .webOrigins = [$origin]
        else .
        end
    ]
' "$SOURCE"
