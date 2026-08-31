# Bootstrap image for the release stack.
#
# WHY IT EXISTS: every one of the things it does — validating the configuration, creating
# Keycloak's database, creating the recordings bucket, applying the production realm — used to be
# a shell script or a JSON file mounted into a container from a git checkout on the deploy host.
# That is what forced a deployment to carry the repository. Baked into an image, the bootstrap
# travels with the release it belongs to, and a deployment is one compose file and one .env.
#
# The production realm in particular is IN this image rather than mounted next to it, so the realm
# and the images that trust it cannot be a version apart.
#
# The base is keycloak-config-cli, because that is the piece that cannot be reimplemented in a
# shell script: it reconciles a live realm to a file, which is what makes realm configuration
# declarative instead of a one-time import. Postgres and MinIO clients are added on top — smaller
# than the reverse, where a JRE and a Spring application would have to be added to an Alpine.
#
# Pinned to a config-cli build made for our Keycloak version: the tag is
# <config-cli version>-<keycloak version>, and each build targets one admin API. This and
# KEYCLOAK_VERSION move together.
FROM adorsys/keycloak-config-cli:6.5.1-26.5.5

ARG TARGETARCH=amd64
# Pinned rather than "latest": a bootstrap image that changes underneath a fixed release tag is
# exactly the drift the whole release stack is built to avoid.
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z

USER root

RUN apt-get update \
    && apt-get install --no-install-recommends -y postgresql-client curl ca-certificates \
    && curl -fsSL -o /usr/local/bin/mc \
        "https://dl.min.io/client/mc/release/linux-${TARGETARCH}/archive/mc.${MC_RELEASE}" \
    && chmod 0755 /usr/local/bin/mc \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# The preflight scripts are the same files the development stack mounts, so there is one copy of
# each check rather than a second one that drifts.
COPY --chmod=0755 scripts/secrets-preflight.sh /opt/quorum/secrets-preflight.sh
COPY --chmod=0755 scripts/kms-preflight.sh /opt/quorum/kms-preflight.sh
COPY --chmod=0755 infra/init/quorum-init.sh /usr/local/bin/quorum-init
COPY infra/keycloak/realm-production.json /opt/quorum/realm-production.json

# Back to the unprivileged user the base image ships with.
USER 65534:65534

ENTRYPOINT ["/usr/local/bin/quorum-init"]
CMD ["preflight"]
