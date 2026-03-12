.PHONY: up down logs build ps clean test-load test-stress test-spike k8s-stress k8s-spike

# ── Docker ────────────────────────────────────────────────────────────────────

## Sobe toda a infra e servicos
up:
	docker compose up -d --build
	@echo ""
	@echo "  Aguardando servicos ficarem prontos..."
	@sleep 10
	@echo ""
	@echo "  Grafana:    http://localhost:3000  (admin/admin)"
	@echo "  Kafka UI:   http://localhost:8080"
	@echo "  Jaeger:     http://localhost:16686"
	@echo "  Prometheus: http://localhost:9090"
	@echo "  MinIO:      http://localhost:9011"
	@echo ""

## Derruba tudo (mantém volumes)
down:
	docker compose down

## Derruba e remove volumes (limpa tudo)
clean:
	docker compose down -v --remove-orphans
	docker volume prune -f

## Build sem subir
build:
	docker compose build

## Status dos containers
ps:
	docker compose ps

## Logs de todos os servicos
logs:
	docker compose logs -f --tail=50

## Logs de um servico especifico (ex: make logs-s SERVICE=user-service)
logs-s:
	docker compose logs -f --tail=100 $(SERVICE)

## Restart de um servico
restart:
	docker compose restart $(SERVICE)

# ── Testes k6 (local) ────────────────────────────────────────────────────────

K6_SERVICES = \
	-e USER_SERVICE_URL=http://user-service:3000 \
	-e WATCH_SERVICE_URL=http://watch-service:3000 \
	-e LIKE_SERVICE_URL=http://like-service:3000 \
	-e PAYMENT_SERVICE_URL=http://payment-service:3000 \
	-e RECO_SERVICE_URL=http://recommendation-service:3000

# Detecta SO: Windows usa PowerShell, Linux/macOS usa bash
ifeq ($(OS),Windows_NT)
  K6_RUN = powershell -NoProfile -ExecutionPolicy Bypass -File scripts/k6-run.ps1
else
  K6_RUN = bash scripts/k6-run.sh
endif

## Load test: carga normal (50 VUs, 5 minutos)
test-load:
	$(K6_RUN) load-test.js

## Stress test: encontrar limite (ate 200 VUs)
test-stress:
	$(K6_RUN) stress-test.js

## Spike test: pico repentino (500 VUs em 30s)
test-spike:
	$(K6_RUN) spike-test.js

# ── Kubernetes ────────────────────────────────────────────────────────────────

## Aplica o stress test no k8s
k8s-stress:
	kubectl apply -f k6/k8s-job.yaml
	@echo "Job k6-stress-test criado. Acompanhe com:"
	@echo "  kubectl logs -f job/k6-stress-test"

## Remove os jobs k6 do k8s
k8s-clean:
	kubectl delete job k6-stress-test k6-spike-test --ignore-not-found

## Acompanhar logs do job k8s
k8s-logs:
	kubectl logs -f job/k6-stress-test

# ── Utilitarios ───────────────────────────────────────────────────────────────

## Verificar saude de todos os servicos
health:
	@echo "=== Health Check ==="
	@curl -sf http://localhost:3001/health | python3 -m json.tool || echo "user-service: DOWN"
	@curl -sf http://localhost:3002/health | python3 -m json.tool || echo "watch-service: DOWN"
	@curl -sf http://localhost:3003/health | python3 -m json.tool || echo "like-service: DOWN"
	@curl -sf http://localhost:3004/health | python3 -m json.tool || echo "payment-service: DOWN"
	@curl -sf http://localhost:3005/health | python3 -m json.tool || echo "recommendation-service: DOWN"

## Seed: cria usuario e faz operacoes de exemplo
seed:
	@echo "Criando usuario de exemplo..."
	@curl -sf -X POST http://localhost:3001/users \
		-H "Content-Type: application/json" \
		-d '{"name":"Pedro Teste","email":"pedro@streaming.test"}' | python3 -m json.tool
	@echo ""
	@echo "Buscando recomendacoes..."
	@curl -sf http://localhost:3005/recommendations/11111111-1111-1111-1111-111111111111 | python3 -m json.tool

## Query rapida no ClickHouse
ch-query:
	@docker compose exec clickhouse clickhouse-client \
		--user streaming --password streaming \
		--query "SELECT ms_name, operation, count() as total FROM logs.events GROUP BY ms_name, operation ORDER BY total DESC LIMIT 20 FORMAT PrettyCompact"

## Top filmes assistidos
ch-top-movies:
	@docker compose exec clickhouse clickhouse-client \
		--user streaming --password streaming \
		--query "SELECT entity_id AS movie_id, count() AS assistidos FROM logs.events WHERE operation='MOVIE_WATCHED' GROUP BY entity_id ORDER BY assistidos DESC LIMIT 10 FORMAT PrettyCompact"

## Usuarios ativos hoje
ch-active-users:
	@docker compose exec clickhouse clickhouse-client \
		--user streaming --password streaming \
		--query "SELECT uniq(user_id) AS usuarios_ativos FROM logs.events WHERE toDate(timestamp) = today() FORMAT PrettyCompact"
