#!/usr/bin/env bash
# k6-run.sh — roda testes k6 via Docker na rede interna do compose (Linux/macOS)
set -e

SCRIPT="${1:-load-test.js}"
K6_DIR="$(cd "$(dirname "$0")/../k6" && pwd)"

docker run --rm \
  --network logs_streaming \
  -e USER_SERVICE_URL=http://user-service:3000 \
  -e WATCH_SERVICE_URL=http://watch-service:3000 \
  -e LIKE_SERVICE_URL=http://like-service:3000 \
  -e PAYMENT_SERVICE_URL=http://payment-service:3000 \
  -e RECO_SERVICE_URL=http://recommendation-service:3000 \
  -v "${K6_DIR}:/scripts" \
  grafana/k6:latest run "/scripts/${SCRIPT}"
