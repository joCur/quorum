# Grafana with this repository's data source and dashboards provisioned.
#
# Dashboards come from this repository rather than from clicks in the UI: a dashboard edited in
# the browser is lost the moment the container is recreated, and nobody else ever sees it.
FROM grafana/grafana:12.3.1

COPY infra/monitoring/grafana/provisioning /etc/grafana/provisioning
COPY infra/monitoring/grafana/dashboards /var/lib/grafana/dashboards
