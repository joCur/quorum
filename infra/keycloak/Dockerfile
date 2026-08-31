# Optimized Keycloak image for the release stack.
#
# WHY THIS EXISTS: `kc.sh start --optimized` refuses to run an augmentation build at startup and
# instead asserts that the image was already built with the build-time options it is asked to use.
# The stock quay.io image is pre-built for the dev-file database, so pointing it at Postgres and
# starting with --optimized fails. Baking the build here is what makes --optimized possible, and
# --optimized is what removes 20-30 seconds of rebuild from every single container start.
#
# The database vendor, the health endpoints and the metrics endpoint are build-time options in
# Keycloak 26. Everything else — hostname, credentials, proxy headers — stays runtime
# configuration, so one image serves every deployment.
ARG KEYCLOAK_VERSION=26.5

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION} AS builder
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_METRICS_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}
COPY --from=builder /opt/keycloak/ /opt/keycloak/

# The login theme. It is copied after the build stage on purpose: a theme is read from disk at
# request time, so it needs no augmentation build, and keeping it out of the builder means editing
# a stylesheet does not invalidate the expensive layer.
COPY infra/keycloak/themes/quorum /opt/keycloak/themes/quorum

# No realm import and no dev clients or users: the release stack provisions its realm explicitly,
# because the committed development realm turns off `sslRequired` and ships known passwords.
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized"]
