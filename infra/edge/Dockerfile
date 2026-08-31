# Edge proxy image — the release stack's single front door.
#
# A thin image: stock unprivileged nginx plus this repository's routing configuration. It exists
# as an image rather than a mounted config file for one reason, and it is the same reason the
# bootstrap image exists — a deployment should be one compose file and one .env, with nothing
# mounted from the host.
#
# The routing itself is deployment-critical and quiet when wrong: a missing WebSocket upgrade
# header breaks recording, a dropped X-Forwarded-Proto breaks every login. Versioning it with the
# release means it is written once and reviewed as a diff, not re-derived per deployment.
#
# It stays SEPARATE from the client image, and that is measured rather than aesthetic: nginx
# resolves the hosts named in upstream blocks at startup and refuses to start when it cannot, so
# a client image carrying this routing table cannot run outside the full stack. The client image
# names no other service and runs standalone; this one owns the topology.
FROM nginxinc/nginx-unprivileged:1.29-alpine

# Rendered by the base image's envsubst step at container start, which is what lets the upstreams
# be overridden without rebuilding.
COPY --chown=nginx:nginx infra/edge/nginx.conf.template /etc/nginx/templates/quorum.conf.template
COPY --chown=nginx:nginx infra/edge/proxy-headers.conf /etc/nginx/quorum-proxy-headers.conf

ENV QUORUM_CLIENT_UPSTREAM=client:8080 \
    QUORUM_API_UPSTREAM=api:8080 \
    QUORUM_KEYCLOAK_UPSTREAM=keycloak:8080 \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
    CMD wget --spider -q http://127.0.0.1:8080/healthz/edge || exit 1
