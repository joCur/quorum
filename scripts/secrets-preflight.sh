#!/bin/sh
# Preflight validation for the release stack's mandatory configuration.
#
# WHY THIS EXISTS: the development compose file is generous on purpose — most variables have a
# default so a fresh checkout starts. A deployment inherits that generosity, and the failure mode
# is silent: a stack that comes up healthy on the placeholder passwords printed in .env.example,
# with the admin console of a public host protected by "CHANGE_ME". Nothing crashes, so nothing
# tells anyone. This gate is the same idea as scripts/kms-preflight.sh — refuse to start rather
# than start wrong — applied to the credentials and public origins instead of the KMS key format.
#
# WHY IT RUNS AS ITS OWN ONE-SHOT SERVICE: every other service depends on it completing
# successfully, so a misconfigured deployment stops with one readable list instead of a cascade of
# unrelated connection errors.
#
# WHAT IT CANNOT DO: it checks that a value is present, long enough and not a placeholder. It has
# no way to know whether the value is the RIGHT one — whether the password matches the database
# that already exists, or the KMS key matches the objects already stored. Only the backup
# procedure in docs/runbooks/backup-restore.md covers that.
set -u

FAILURES=0

# Everything, failures included, goes to stdout. Splitting the two streams looked tidier and
# read terribly: Docker interleaves them independently, so the failures landed under the wrong
# headings. The exit code is what signals the failure; the output only has to be readable.
fail() {
  echo "  FAIL  $1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "  ok    $1"
}

# Substrings that mark a value as something nobody chose. Matched case-insensitively, anywhere in
# the value, because the placeholders in .env.example and in the average first deployment are
# variations on these.
is_placeholder() {
  value=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$value" in
    *change_me* | *changeme* | *change-me* | *replace_me* | *replaceme* | *replace-me* | \
      *placeholder* | *example* | *your_* | *xxxx* | password | passwort | secret | admin | \
      test | changethis | sk-or-...)
      return 0
      ;;
  esac
  return 1
}

# A credential: present, not a placeholder, and long enough that it was generated rather than
# typed. 16 characters is below what `openssl rand -base64 24` produces and above what anyone
# invents at a keyboard.
require_secret() {
  name="$1"
  eval "value=\${$name:-}"

  if [ -z "$value" ]; then
    fail "$name is empty or unset."
    return
  fi
  if is_placeholder "$value"; then
    fail "$name still holds a placeholder value. Generate one: openssl rand -hex 24"
    return
  fi
  if [ "${#value}" -lt 16 ]; then
    fail "$name is only ${#value} characters; at least 16 are required. Generate one: openssl rand -hex 24"
    return
  fi
  pass "$name"
}

# A credential that additionally ends up inside a URL, and therefore cannot contain a character
# that means something to a URL parser.
#
# WHY: the compose file assembles DATABASE_URL as postgres://user:PASSWORD@postgres:5432/db. A
# password containing "/" — which `openssl rand -base64` produces about half the time — truncates
# that URL, and the API and the worker then crash-loop against a host named after the database
# user. The error says ENOTFOUND and names something that looks nothing like a password, so the
# password is the last place anyone looks. Refusing the value here costs one regenerated secret;
# not refusing it costs an afternoon.
require_url_safe_secret() {
  name="$1"
  eval "value=\${$name:-}"

  # Checked before the generic rules, so a value that is both too short and unsafe reports the
  # thing that would have been hardest to diagnose.
  case "$value" in
    *[:/?\#\[\]@%\&\+\ ]*)
      fail "$name contains a character that is not safe inside a URL (one of : / ? # [ ] @ % & + or a space). It is embedded in DATABASE_URL, where such a character silently truncates the connection string. Generate one without: openssl rand -hex 24"
      return
      ;;
  esac

  require_secret "$name"
}

# A non-credential value that still must not be a placeholder — an identifier, a bucket name, a
# model name. No length rule: "recordings" is a perfectly good bucket name.
require_value() {
  name="$1"
  eval "value=\${$name:-}"

  if [ -z "$value" ]; then
    fail "$name is empty or unset."
    return
  fi
  if is_placeholder "$value"; then
    fail "$name still holds a placeholder value."
    return
  fi
  pass "$name"
}

# A public origin: browsers reach it, so it has to be HTTPS and it cannot be a loopback address.
# Keycloak puts this value into the `iss` claim of every token, and the API validates it — a
# leftover http://localhost here produces a login that fails only for real users.
require_public_https_url() {
  name="$1"
  eval "value=\${$name:-}"

  if [ -z "$value" ]; then
    fail "$name is empty or unset."
    return
  fi
  case "$value" in
    https://*) ;;
    *)
      fail "$name must be an https:// URL — TLS is terminated in the reverse proxy in front of this stack. Got: $value"
      return
      ;;
  esac
  case "$value" in
    *localhost* | *127.0.0.1* | *0.0.0.0* | *::1*)
      fail "$name points at a loopback address ($value). It has to be the origin browsers use."
      return
      ;;
  esac
  pass "$name"
}

# A strict boolean. Used for the switches that are substituted straight into the realm JSON, where
# anything other than the two literal words produces a realm import that either fails or, worse,
# silently reads as false.
require_boolean() {
  name="$1"
  eval "value=\${$name:-}"

  case "$value" in
    true | false)
      pass "$name=$value"
      ;;
    "")
      fail "$name is empty or unset. It must be exactly true or false."
      ;;
    *)
      fail "$name must be exactly true or false (it is substituted into the realm as a JSON boolean). Got: $value"
      ;;
  esac
}

# The mail relay.
#
# WHY IT IS A GROUP AND NOT SIX INDEPENDENT CHECKS: mail is optional, and the settings only have to
# be present when it is switched on. QUORUM_SMTP_ENABLED is the switch, and it does two things at
# once — it decides whether these values are mandatory here, and it is the same value the realm
# substitutes into `resetPasswordAllowed`. That is deliberate: a deployment cannot end up offering
# a "Forgot password?" link while having no way to deliver the mail behind it, because one variable
# governs both.
#
# The relay password is checked for presence and for placeholders but not for length. Length is a
# rule about secrets WE generate; this one is issued by a mail provider, and refusing a short
# credential the operator cannot change would only teach them to work around the preflight.
require_mail() {
  require_boolean QUORUM_SMTP_ENABLED

  if [ "${QUORUM_SMTP_ENABLED:-}" = "false" ]; then
    echo "  note  mail delivery is off. Password reset and address verification stay disabled,"
    echo "        and the sign-in page shows no link to them. Set QUORUM_SMTP_ENABLED=true and"
    echo "        the SMTP_* values documented in .env.example to switch them on."
    return
  fi

  # Anything other than the two literal words already failed above; there is nothing sensible to
  # check against a switch nobody can read.
  [ "${QUORUM_SMTP_ENABLED:-}" = "true" ] || return

  require_value SMTP_HOST
  require_value SMTP_FROM

  case "${SMTP_PORT:-}" in
    "")
      fail "SMTP_PORT is empty or unset. Common values: 587 for STARTTLS, 465 for implicit TLS."
      ;;
    *[!0-9]*)
      fail "SMTP_PORT must be a number. Got: ${SMTP_PORT}"
      ;;
    *)
      pass "SMTP_PORT"
      ;;
  esac

  case "${SMTP_FROM:-}" in
    ?*@?*.?*) ;;
    "") ;;
    *)
      fail "SMTP_FROM must be a mail address the relay is allowed to send as. Got: ${SMTP_FROM}"
      ;;
  esac

  require_boolean SMTP_SSL
  require_boolean SMTP_STARTTLS
  require_boolean SMTP_AUTH

  # Plain SMTP to a relay somewhere else on the internet sends the credentials and every
  # verification link in the clear. A relay on the same host is a different matter, so this is not
  # refused outright — but it is not allowed to be silent either.
  if [ "${SMTP_SSL:-}" != "true" ] && [ "${SMTP_STARTTLS:-}" != "true" ]; then
    echo "  note  SMTP_SSL and SMTP_STARTTLS are both false: mail leaves this host unencrypted."
    echo "        Fine for a relay on localhost, wrong for anything reached over a network."
  fi

  if [ "${SMTP_AUTH:-}" = "true" ]; then
    require_value SMTP_USER
    if [ -z "${SMTP_PASSWORD:-}" ]; then
      fail "SMTP_PASSWORD is empty or unset, but SMTP_AUTH is true."
    elif is_placeholder "${SMTP_PASSWORD}"; then
      fail "SMTP_PASSWORD still holds a placeholder value."
    else
      pass "SMTP_PASSWORD"
    fi
  fi
}

# Called with argument names instead of none, the script checks exactly those variables as
# credentials and nothing else. The monitoring profile uses this: its one secret cannot be part
# of the list below, because Compose interpolates every service in the file whether or not its
# profile is active, so a mandatory monitoring variable would block a stack that never enables it.
if [ "$#" -gt 0 ]; then
  echo "Configuration preflight ($*)"
  echo
  for name in "$@"; do
    require_secret "$name"
  done
  echo
  if [ "$FAILURES" -gt 0 ]; then
    echo "Preflight FAILED: $FAILURES value(s) are missing or still hold a placeholder."
    exit 1
  fi
  echo "Preflight OK."
  exit 0
fi

echo "Release configuration preflight"
echo

echo "Credentials:"
require_url_safe_secret POSTGRES_PASSWORD
require_secret KEYCLOAK_DB_PASSWORD
require_secret KEYCLOAK_ADMIN_PASSWORD
require_secret MINIO_ROOT_PASSWORD
# Format and length are checked by scripts/kms-preflight.sh, which knows what MinIO requires.
# Here the only question is whether anyone replaced the value at all.
require_value MINIO_KMS_SECRET_KEY

echo
echo "Summary backend:"
# A self-hosted OpenAI-compatible endpoint usually ignores the key, and "unused" is the documented
# value for that case — so this is require_value, not require_secret. The placeholder check still
# catches the "sk-or-..." that .env.example ships.
require_value SUMMARY_API_KEY
require_value SUMMARY_BASE_URL
require_value SUMMARY_MODEL

echo
echo "Mail delivery:"
require_mail

echo
echo "Public origins:"
require_public_https_url QUORUM_PUBLIC_URL
require_public_https_url KEYCLOAK_PUBLIC_URL

echo
echo "Storage and database identifiers:"
require_value POSTGRES_USER
require_value POSTGRES_DB
require_value MINIO_ROOT_USER
require_value S3_BUCKET

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "Preflight FAILED: $FAILURES value(s) are missing or still hold a placeholder."
  echo
  echo "Set them in the .env file next to docker-compose.release.yml. Every variable above is"
  echo "documented in .env.example, and docs/deployment.md lists which ones are mandatory."
  echo "The stack will not start until they are set."
  exit 1
fi

echo "Preflight OK — all mandatory values are set."
