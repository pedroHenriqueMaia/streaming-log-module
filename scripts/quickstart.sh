#!/usr/bin/env bash
# quickstart.sh — setup completo apos git clone (Linux/macOS)
# Uso: ./scripts/quickstart.sh
# Ou com load test: ./scripts/quickstart.sh --run-test

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_TEST=false
[[ "$1" == "--run-test" ]] && RUN_TEST=true

step() { echo -e "\n\033[36m==> $1\033[0m"; }
ok()   { echo -e "    \033[32m[OK]\033[0m $1"; }
warn() { echo -e "    \033[33m[WARN]\033[0m $1"; }
fail() { echo -e "    \033[31m[ERRO]\033[0m $1"; exit 1; }

# ── 1. Pre-requisitos ─────────────────────────────────────────────────────────
step "Verificando pre-requisitos..."

command -v docker &>/dev/null || fail "Docker nao encontrado. Instale: https://docs.docker.com/engine/install/"
ok "Docker: $(docker --version)"

docker info &>/dev/null || fail "Docker daemon nao esta rodando. Inicie o Docker e tente novamente."
ok "Docker daemon: rodando"

# ── 2. Subir ambiente ─────────────────────────────────────────────────────────
step "Subindo todos os containers (build + start)..."
docker compose up -d --build

# ── 3. Aguardar servicos ──────────────────────────────────────────────────────
step "Aguardando servicos ficarem prontos..."

wait_http() {
  local name=$1 url=$2 max=60 i=0
  printf "    Aguardando %s" "$name"
  while ! curl -sf "$url" &>/dev/null; do
    sleep 2; i=$((i+2))
    printf "."
    [[ $i -ge $max ]] && echo " TIMEOUT" && return 1
  done
  echo " OK"
}

wait_container_healthy() {
  local name=$1 container=$2 max=60 i=0
  printf "    Aguardando %s" "$name"
  while [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null)" != "healthy" ]]; do
    sleep 2; i=$((i+2))
    printf "."
    [[ $i -ge $max ]] && echo " TIMEOUT" && return 1
  done
  echo " OK"
}

wait_container_healthy "Kafka"      "logs-kafka-1"
wait_http              "ClickHouse" "http://localhost:8123/ping"
wait_http              "user-service"  "http://localhost:3001/health"
wait_http              "watch-service" "http://localhost:3002/health"
wait_http              "like-service"  "http://localhost:3003/health"

# ── 4. Seed de dados ──────────────────────────────────────────────────────────
step "Criando dados de exemplo..."

USER=$(curl -sf -X POST http://localhost:3001/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Dev Teste","email":"dev@streaming.test"}')

USER_ID=$(echo "$USER" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
ok "Usuario criado: $USER_ID"

for movie in \
  "11111111-1111-1111-1111-111111111111" \
  "22222222-2222-2222-2222-222222222222" \
  "33333333-3333-3333-3333-333333333333"
do
  curl -sf -X POST http://localhost:3002/watch \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"$USER_ID\",\"movie_id\":\"$movie\",\"duration_seconds\":3600}" >/dev/null
  curl -sf -X POST http://localhost:3003/likes \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"$USER_ID\",\"movie_id\":\"$movie\"}" >/dev/null
done

curl -sf -X POST http://localhost:3004/subscriptions \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"$USER_ID\",\"plan\":\"premium\",\"card_token\":\"tok_visa\"}" >/dev/null

ok "Eventos gerados (watch, like, subscription)"

sleep 5

# ── 5. Verificar ClickHouse ───────────────────────────────────────────────────
step "Verificando dados no ClickHouse..."

RESULT=$(docker compose exec clickhouse clickhouse-client \
  --user streaming --password streaming \
  --query "SELECT ms_name, operation, count() as total FROM logs.events GROUP BY ms_name, operation ORDER BY total DESC FORMAT TSV" 2>/dev/null)

if [[ -n "$RESULT" ]]; then
  ok "ClickHouse com dados:"
  echo "$RESULT" | while IFS= read -r line; do echo "    $line"; done
else
  warn "ClickHouse ainda sem dados (aguarde e rode: make ch-query)"
fi

# ── 6. URLs ───────────────────────────────────────────────────────────────────
step "Ambiente pronto!"
echo ""
echo -e "  \033[33mGrafana (dashboards):\033[0m http://localhost:3000  (admin/admin)"
echo -e "  \033[33mKafka UI:\033[0m             http://localhost:8080"
echo -e "  \033[33mJaeger (traces):\033[0m      http://localhost:16686"
echo -e "  \033[33mPrometheus:\033[0m           http://localhost:9090"
echo -e "  \033[33mMinIO (cold storage):\033[0m http://localhost:9011  (streaming/streaming123)"
echo ""
echo -e "  \033[36mComandos uteis:\033[0m"
echo "    make test-load     — load test (50 VUs, 5 min)"
echo "    make test-stress   — stress test (ate 200 VUs)"
echo "    make ch-query      — ver eventos no ClickHouse"
echo "    make health        — saude dos servicos"
echo "    make logs          — logs em tempo real"
echo ""

# ── 7. Teste de carga opcional ────────────────────────────────────────────────
if $RUN_TEST; then
  step "Rodando load test (50 VUs, 5 minutos)..."
  bash "$(dirname "$0")/k6-run.sh" load-test.js
fi
