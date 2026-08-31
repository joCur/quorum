# Prometheus with this repository's scrape configuration and alert rules baked in.
#
# A thin config-carrying image, for the same reason as the edge and bootstrap images: nothing in
# the release stack is mounted from the host, so a deployment is one compose file and one .env.
# The alert rules are reviewed as diffs in this repository and ship with the release they belong
# to — see docs/runbooks/pipeline.md for the response to each one.
FROM prom/prometheus:v3.7.3

COPY infra/monitoring/prometheus.yml /etc/prometheus/prometheus.yml
COPY infra/monitoring/rules /etc/prometheus/rules
