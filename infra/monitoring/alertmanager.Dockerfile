# Alertmanager with this repository's routing configuration baked in.
#
# Note what this does NOT do: it raises alerts, it does not deliver them anywhere. Configuring a
# real receiver is a deployment's own step — see docs/runbooks/pipeline.md.
FROM prom/alertmanager:v0.28.1

COPY infra/monitoring/alertmanager.yml /etc/alertmanager/alertmanager.yml
