# Streaming Platform — Log Module

Sistema de logging event-driven para plataforma de streaming com 500k+ usuarios.

> Documentacao detalhada: [Arquitetura](docs/ARCHITECTURE.md) | [Por que cada componente](docs/PURPOSE.md)

---

## Requisito

[Docker Desktop](https://docs.docker.com/desktop/install/) instalado e rodando. Nada mais.

---

## Quickstart

```bash
git clone <repo-url> logs
cd logs
```

**Windows (PowerShell)**
```powershell
.\scripts\quickstart.ps1
```

**Linux / macOS**
```bash
chmod +x scripts/*.sh && ./scripts/quickstart.sh
```

O script builda as imagens, sobe os 20 containers, aguarda os servicos ficarem prontos e gera dados de seed automaticamente.

---

## Comandos — com Make

```bash
# Ambiente
make up            # sobe tudo (build + start)
make down          # derruba (mantem volumes)
make clean         # derruba + apaga todos os volumes
make ps            # status dos containers
make logs          # logs de todos em tempo real
make health        # health check dos microservicos

# Testes de carga
make test-load     # 50 VUs, 5 minutos — carga normal
make test-stress   # ate 200 VUs — encontrar limite
make test-spike    # 500 VUs em 30s — pico repentino

# ClickHouse
make ch-query      # eventos por servico/operacao
make ch-top-movies # top filmes mais assistidos
make ch-active-users # usuarios ativos hoje
```

---

## Comandos — sem Make (manual)

**Subir e derrubar**
```bash
docker compose up -d --build   # sobe tudo
docker compose down            # derruba
docker compose down -v         # derruba + limpa volumes
docker compose ps              # status
docker compose logs -f         # logs em tempo real
```

**Rebuild de um servico especifico**
```bash
docker compose up -d --build user-service
docker compose up -d --build log-processor
```

**Testes de carga**

Windows:
```powershell
.\scripts\quickstart.ps1 -RunTest         # load test
powershell -File scripts/k6-run.ps1 load-test.js
powershell -File scripts/k6-run.ps1 stress-test.js
powershell -File scripts/k6-run.ps1 spike-test.js
```

Linux / macOS:
```bash
bash scripts/k6-run.sh load-test.js
bash scripts/k6-run.sh stress-test.js
bash scripts/k6-run.sh spike-test.js
```

**Queries no ClickHouse**
```bash
# Eventos por servico
docker compose exec clickhouse clickhouse-client \
  --user streaming --password streaming \
  --query "SELECT ms_name, operation, count() as total FROM logs.events GROUP BY ms_name, operation ORDER BY total DESC FORMAT PrettyCompact"

# Top filmes assistidos
docker compose exec clickhouse clickhouse-client \
  --user streaming --password streaming \
  --query "SELECT entity_id AS movie_id, count() AS assistidos FROM logs.events WHERE operation='MOVIE_WATCHED' GROUP BY entity_id ORDER BY assistidos DESC LIMIT 10 FORMAT PrettyCompact"

# Usuarios ativos hoje
docker compose exec clickhouse clickhouse-client \
  --user streaming --password streaming \
  --query "SELECT uniq(user_id) AS usuarios_ativos FROM logs.events WHERE toDate(timestamp) = today() FORMAT PrettyCompact"
```

**Testar microservicos via curl**
```bash
# Criar usuario
curl -X POST http://localhost:3001/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Pedro","email":"pedro@test.com"}'

# Registrar assistida
curl -X POST http://localhost:3002/watch \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<id>","movie_id":"11111111-1111-1111-1111-111111111111","duration_seconds":3600}'

# Curtir filme
curl -X POST http://localhost:3003/likes \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<id>","movie_id":"11111111-1111-1111-1111-111111111111"}'

# Buscar recomendacoes
curl http://localhost:3005/recommendations/<user_id>
```

---

## Links diretos

### Interfaces Web

| Servico | URL | Credenciais |
|---|---|---|
| **Grafana** (dashboards) | http://localhost:3000 | admin / admin |
| **Kafka UI** (topicos, mensagens) | http://localhost:8080 | — |
| **Jaeger** (traces distribuidos) | http://localhost:16686 | — |
| **Prometheus** (metricas) | http://localhost:9090 | — |
| **MinIO** (cold storage) | http://localhost:9011 | streaming / streaming123 |

### Prometheus — paginas uteis

| Pagina | URL |
|---|---|
| Targets (status do scraping) | http://localhost:9090/targets |
| Graph (explorar metricas) | http://localhost:9090/graph |
| Alertas | http://localhost:9090/alerts |
| Query: requests por segundo | http://localhost:9090/graph?g0.expr=sum(rate(http_requests_total%5B1m%5D))by(service) |
| Query: latencia P95 | http://localhost:9090/graph?g0.expr=histogram_quantile(0.95%2Csum(rate(http_request_duration_seconds_bucket%5B5m%5D))by(le%2Cservice)) |
| Query: inserts ClickHouse | http://localhost:9090/graph?g0.expr=rate(clickhouse_inserts_total%5B1m%5D) |

> **Nota:** Na pagina `/targets` os links de cada target (ex: `kafka-exporter:9308/metrics`) apontam para o hostname interno do Docker e **nao funcionam no browser**. Isso e esperado — o Prometheus scrapa pela rede interna. Para acessar as metricas raw de cada servico pelo browser, use as portas do host abaixo.

### Metricas raw (Prometheus format)

| Servico | URL no host |
|---|---|
| user-service | http://localhost:3001/metrics |
| watch-service | http://localhost:3002/metrics |
| like-service | http://localhost:3003/metrics |
| payment-service | http://localhost:3004/metrics |
| recommendation-service | http://localhost:3005/metrics |
| kafka-exporter | http://localhost:9308/metrics |
| otel-collector | http://localhost:8889/metrics |

> `log-processor` nao expoe porta no host — suas metricas so sao acessiveis pelo Prometheus internamente.

### APIs dos microservicos

| Servico | Base URL | Endpoints |
|---|---|---|
| user-service | http://localhost:3001 | `POST /users`, `POST /users/login`, `GET /users/:id` |
| watch-service | http://localhost:3002 | `POST /watch`, `POST /watch/pause`, `GET /watch/history/:userId` |
| like-service | http://localhost:3003 | `POST /likes`, `DELETE /likes`, `GET /likes/:userId` |
| payment-service | http://localhost:3004 | `POST /subscriptions`, `GET /subscriptions/:userId`, `DELETE /subscriptions/:id` |
| recommendation-service | http://localhost:3005 | `GET /recommendations/:userId`, `POST /recommendations/:userId/click` |

### Bancos de dados (acesso direto)

```bash
# ClickHouse
docker compose exec clickhouse clickhouse-client --user streaming --password streaming

# PostgreSQL
docker compose exec postgres psql -U streaming -d streaming

# Redis
docker compose exec redis redis-cli
```

---

## Estrutura do projeto

```
.
├── README.md                          # este arquivo — como rodar
├── docs/
│   ├── ARCHITECTURE.md               # arquitetura tecnica detalhada
│   └── PURPOSE.md                    # por que cada componente existe
├── docker-compose.yml
├── Makefile
├── scripts/
│   ├── quickstart.ps1 / .sh          # setup pos git clone
│   └── k6-run.ps1 / .sh             # wrapper dos testes k6
├── services/
│   ├── user-service/
│   ├── watch-service/
│   ├── like-service/
│   ├── payment-service/
│   ├── recommendation-service/
│   └── log-processor/
├── infra/
│   ├── clickhouse/init.sql
│   └── postgres/init.sql
├── observability/
│   ├── otel-collector/config.yaml
│   ├── prometheus/prometheus.yml
│   ├── promtail/config.yaml
│   └── grafana/
│       ├── provisioning/datasources/
│       ├── provisioning/dashboards/
│       └── dashboards/streaming-logs.json
└── k6/
    ├── load-test.js
    ├── stress-test.js
    ├── spike-test.js
    ├── utils.js
    └── k8s-job.yaml
```
