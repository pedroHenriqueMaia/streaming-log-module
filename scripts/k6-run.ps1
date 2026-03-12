# k6-run.ps1 — roda testes k6 via Docker na rede interna do compose
param([string]$Script = "load-test.js")

$ScriptDir = Split-Path -Parent $PSScriptRoot
$K6Dir = Join-Path $ScriptDir "k6"

docker run --rm `
  --network logs_streaming `
  -e USER_SERVICE_URL=http://user-service:3000 `
  -e WATCH_SERVICE_URL=http://watch-service:3000 `
  -e LIKE_SERVICE_URL=http://like-service:3000 `
  -e PAYMENT_SERVICE_URL=http://payment-service:3000 `
  -e RECO_SERVICE_URL=http://recommendation-service:3000 `
  -v "${K6Dir}:/scripts" `
  grafana/k6:latest run "/scripts/$Script"
