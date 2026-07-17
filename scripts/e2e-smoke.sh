#!/usr/bin/env bash
#
# End-to-end smoke test for the compose stack (docs/spec.md section 3.10).
#
# Brings up paperhanger + GreptimeDB + Grafana + webhook-sink, posts a
# realistic Grafana-format alert directly at paperhanger's webhook endpoint
# (bypassing Grafana's own alert-rule evaluation, which is too slow/flaky for
# a fast, deterministic smoke test -- Grafana itself is still provisioned
# with a real contact point/policy as a manual playground; see README.md),
# then polls incident state until it reaches a terminal status and asserts:
#
#   - the incident reached `report_only` (the default e2e config has no repo
#     mappings, so repo resolution always returns null -- the "NO-LLM path")
#   - webhook-sink received the corresponding `report_only` notification
#
# Requires: docker (with the `compose` plugin), curl, jq.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

GRAFANA_WEBHOOK_SECRET="${GRAFANA_WEBHOOK_SECRET:-e2e-grafana-secret}"
# Must match the fixed `server.apiToken` in e2e/paperhanger.yaml -- GET
# /incidents is unauthenticated-by-default-refused (see README.md's config
# reference), so polling it here requires this bearer token.
PAPERHANGER_API_TOKEN="e2e-incidents-api-token"
PAPERHANGER_URL="http://localhost:8080"
WEBHOOK_SINK_URL="http://localhost:8081"
INCIDENT_POLL_TIMEOUT_SECONDS=60
NOTIFICATION_POLL_TIMEOUT_SECONDS=20
POLL_INTERVAL_SECONDS=2

RESPONSE_FILE="$(mktemp)"

log() {
	echo "[e2e-smoke] $*" >&2
}

cleanup() {
	local status=$?
	log "Tearing down the compose stack..."
	docker compose down -v --remove-orphans >/dev/null 2>&1 || true
	rm -f "$RESPONSE_FILE"
	exit "$status"
}
trap cleanup EXIT

for bin in docker curl jq; do
	if ! command -v "$bin" >/dev/null 2>&1; then
		log "FAIL: required tool '$bin' not found on PATH"
		exit 1
	fi
done

log "Building and starting the compose stack (docker compose up --build --wait)..."
docker compose up --build --wait --wait-timeout 180

FINGERPRINT="e2e-smoke-$(date +%s)-$$"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log "Posting a Grafana-format alert (fingerprint=${FINGERPRINT})..."
PAYLOAD=$(
	cat <<EOF
{
  "receiver": "paperhanger-e2e",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "HighErrorRate",
        "service": "checkout-api",
        "severity": "critical"
      },
      "annotations": {
        "summary": "Checkout API error rate above threshold"
      },
      "startsAt": "${NOW}",
      "generatorURL": "http://grafana:3000/alerting/grafana/e2e-smoke/view",
      "fingerprint": "${FINGERPRINT}"
    }
  ],
  "groupKey": "e2e-smoke",
  "externalURL": "http://grafana:3000"
}
EOF
)

HTTP_STATUS=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" \
	-X POST "${PAPERHANGER_URL}/webhooks/grafana?token=${GRAFANA_WEBHOOK_SECRET}" \
	-H "content-type: application/json" \
	-d "$PAYLOAD")

if [ "$HTTP_STATUS" != "202" ]; then
	log "FAIL: expected HTTP 202 from the webhook endpoint, got ${HTTP_STATUS}"
	cat "$RESPONSE_FILE" >&2
	exit 1
fi
log "Webhook accepted: $(cat "$RESPONSE_FILE")"

log "Checking that GET /incidents rejects requests without the api token..."
UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${PAPERHANGER_URL}/incidents")
if [ "$UNAUTH_STATUS" != "401" ]; then
	log "FAIL: expected HTTP 401 from GET /incidents without a token, got ${UNAUTH_STATUS}"
	exit 1
fi
log "Confirmed: GET /incidents requires the api token (401 without it)."

log "Polling GET /incidents for a terminal state on fingerprint=${FINGERPRINT}..."
deadline=$((SECONDS + INCIDENT_POLL_TIMEOUT_SECONDS))
incident_json=""
incident_status=""
while [ "$SECONDS" -lt "$deadline" ]; do
	incident_json=$(curl -s "${PAPERHANGER_URL}/incidents?limit=50" \
		-H "Authorization: Bearer ${PAPERHANGER_API_TOKEN}" |
		jq -c --arg fp "$FINGERPRINT" '.incidents[] | select(.fingerprint == $fp)')
	if [ -n "$incident_json" ]; then
		incident_status=$(echo "$incident_json" | jq -r '.status')
		log "  incident status: ${incident_status}"
		case "$incident_status" in
		report_only | pr_created | failed | skipped)
			break
			;;
		esac
	fi
	sleep "$POLL_INTERVAL_SECONDS"
done

if [ -z "$incident_json" ]; then
	log "FAIL: no incident with fingerprint=${FINGERPRINT} ever appeared"
	exit 1
fi
log "Final incident record: $(echo "$incident_json" | jq -c .)"

if [ "$incident_status" != "report_only" ]; then
	log "FAIL: expected terminal status 'report_only' (no-LLM path: no repo mappings configured), got '${incident_status}'"
	exit 1
fi

diagnosis=$(echo "$incident_json" | jq -r '.diagnosis // empty')
if [[ "$diagnosis" != *"could not be confidently resolved"* ]]; then
	log "FAIL: expected the report_only diagnosis to explain the unresolved repository, got: ${diagnosis}"
	exit 1
fi
log "Diagnosis: ${diagnosis}"

log "Checking that webhook-sink received the report_only notification..."
deadline=$((SECONDS + NOTIFICATION_POLL_TIMEOUT_SECONDS))
notification_json=""
while [ "$SECONDS" -lt "$deadline" ]; do
	notification_json=$(curl -s "${WEBHOOK_SINK_URL}/received" |
		jq -c --arg fp "$FINGERPRINT" \
			'.received[] | select(.body.incident.fingerprint == $fp and .body.kind == "report_only")')
	if [ -n "$notification_json" ]; then
		break
	fi
	sleep 1
done

if [ -z "$notification_json" ]; then
	log "FAIL: webhook-sink never received a report_only notification for fingerprint=${FINGERPRINT}"
	curl -s "${WEBHOOK_SINK_URL}/received" | jq . >&2 || true
	exit 1
fi
log "webhook-sink received: $(echo "$notification_json" | jq -c .)"

log "PASS: incident reached report_only and webhook-sink observed the notification."
