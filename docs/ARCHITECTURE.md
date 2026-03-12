# Arquitetura Tecnica

## Visao geral

```
┌──────────────────────────── Microservices Layer ─────────────────────────────┐
│  user-service  │  watch-service  │  like-service  │  payment-service  │  reco │
│   :3001        │   :3002         │   :3003         │   :3004           │  :3005│
└────────┬───────┴────────┬────────┴────────┬────────┴──────────┬────────┴───┬──┘
         │  publica eventos no Kafka         │                   │            │
┌────────▼───────────────────────────────────▼───────────────────▼────────────▼──┐
│                         Apache Kafka — Event Bus                                │
│   user.events  |  watch.events  |  like.events  |  payment.events | ms.ops     │
└────────────────────────────────────┬───────────────────────────────────────────┘
                                     │ consome (group: log-processor-group)
                          ┌──────────▼──────────┐
                          │    log-processor     │
                          │  batch 100 eventos   │
                          │  ou flush a cada 2s  │
                          └──┬───────────────────┘
                             │ INSERT batch
                  ┌──────────▼──────────┐
                  │     ClickHouse      │  ← armazenamento principal de logs
                  │  logs.events        │    MergeTree, particao por mes
                  │  TTL: 90 dias       │    bloom_filter + set indexes
                  └─────────────────────┘
                             │ apos TTL
                  ┌──────────▼──────────┐
                  │       MinIO         │  ← cold storage (S3-compatible)
                  │  bucket: cold-logs  │    logs arquivados
                  └─────────────────────┘

Cada microservico tambem le/escreve diretamente:
  ┌──────────────┐    ┌──────────────┐
  │  PostgreSQL  │    │    Redis     │
  │  usuarios    │    │  contadores  │
  │  historico   │    │  likes sets  │
  │  assinaturas │    │  (tempo real)│
  └──────────────┘    └──────────────┘

Observabilidade (paralelo, sempre ativo):
  Servicos ──OTLP gRPC──► OTel Collector ──► Jaeger  (traces)
                                         └──► Prometheus (metrics endpoint :8889)
  Prometheus ──scrape──► todos os /metrics
  Promtail ──Docker socket──► Loki  (logs JSON)
  Prometheus + Loki + Jaeger ──────────────► Grafana (dashboards)
```

---

## Kafka — Topicos e eventos

| Topico | Produtor | Eventos |
|---|---|---|
| `user.events` | user-service | `ACCOUNT_CREATED`, `USER_LOGIN` |
| `watch.events` | watch-service | `MOVIE_WATCHED`, `MOVIE_PAUSED`, `MOVIE_RESUMED` |
| `like.events` | like-service | `MOVIE_LIKED`, `MOVIE_UNLIKED` |
| `payment.events` | payment-service | `SUBSCRIPTION_CREATED`, `SUBSCRIPTION_CANCELLED` |
| `ms.operations` | recommendation-service | `RECO_GENERATED`, `RECO_CLICKED` |

Todos os topicos sao consumidos pelo `log-processor` no consumer group `log-processor-group`.

### Schema do evento (JSON no valor da mensagem Kafka)

```json
{
  "log_id":    "uuid-v4",
  "timestamp": "2026-03-12T14:00:00.000Z",
  "ms_name":   "watch-service",
  "operation": "MOVIE_WATCHED",
  "user_id":   "b360ea19-eb25-460d-a90a-7d7c15465180",
  "entity_id": "11111111-1111-1111-1111-111111111111",
  "session_id": "8b80bba8-2eec-4d7f-ad5e-949de8224fbf",
  "metadata":  "{\"duration_seconds\":3600,\"device\":\"web\"}",
  "ip":        "200.x.x.x",
  "device":    "web"
}
```

---

## ClickHouse — Schema

### Tabela principal: `logs.events`

```sql
CREATE TABLE logs.events (
    log_id      UUID            DEFAULT generateUUIDv4(),
    timestamp   DateTime64(3)   DEFAULT now64(),
    ms_name     LowCardinality(String),   -- ex: "watch-service"
    operation   LowCardinality(String),   -- ex: "MOVIE_WATCHED"
    user_id     String,
    entity_id   String,                   -- movie_id, subscription_id, etc
    session_id  String,
    metadata    String,                   -- JSON stringificado
    ip          String,
    device      LowCardinality(String),

    INDEX idx_user_id   user_id   TYPE bloom_filter GRANULARITY 1,
    INDEX idx_operation operation TYPE set(50)       GRANULARITY 1,
    INDEX idx_ms_name   ms_name   TYPE set(20)       GRANULARITY 1
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)     -- uma particao por mes
ORDER BY (timestamp, ms_name, user_id)
TTL toDateTime(timestamp) + INTERVAL 90 DAY  -- expira apos 90 dias
SETTINGS index_granularity = 8192;
```

**Por que LowCardinality?** `ms_name` e `operation` tem poucos valores distintos. O ClickHouse usa dictionary encoding automaticamente, economizando ~4x de espacio e acelerando GROUP BY.

### Views materializadas

| View | Engine | Finalidade |
|---|---|---|
| `events_by_service_hourly` | SummingMergeTree | contagem de eventos por servico/hora |
| `top_movies_daily` | SummingMergeTree | filmes mais assistidos por dia |
| `active_users_daily` | AggregatingMergeTree | usuarios unicos por dia (HyperLogLog) |

As views sao populadas em tempo real conforme eventos chegam — sem precisar rodar queries pesadas depois.

---

## Log-processor — Estrategia de batch

```
Kafka message → buffer em memoria
                      │
          ┌───────────┴───────────┐
          │                       │
    buffer >= 100 eventos   timer de 2 segundos
          │                       │
          └───────────┬───────────┘
                      │
              INSERT batch no ClickHouse
              (uma unica operacao HTTP)
```

**Por que batch?** Um INSERT por evento no ClickHouse geraria muitos parts pequenos, causando merge storms. O batch de 100 eventos ou 2s garante throughput alto mantendo o ClickHouse saudavel.

---

## Observabilidade — Tres pilares

### Traces (Jaeger)
Cada request HTTP gera um trace com spans em cada operacao:
```
POST /watch  [12ms]
  ├── kafka.produce  [2ms]
  ├── redis.incr     [1ms]
  └── pg.query       [8ms]
```
Acesse: http://localhost:16686

### Metricas (Prometheus + Grafana)
Cada servico expoe `/metrics` no formato Prometheus. O Prometheus scrapa a cada 15s.

Principais metricas:
- `http_requests_total{service, method, route, status}` — contador de requests
- `http_request_duration_seconds{...}` — histograma de latencia (p50/p95/p99)
- `clickhouse_inserts_total` — inserts no ClickHouse
- `events_processed_total{ms_name, operation}` — eventos processados
- `kafka_consumer_lag` — lag do consumer (via kafka-exporter)

Acesse: http://localhost:9090

### Logs (Loki + Promtail)
Todos os containers emitem logs JSON via stdout. O Promtail coleta via Docker socket e envia ao Loki. No Grafana voce filtra:
```
{container="logs-user-service-1"} | json | level="error"
{container=~"logs-.*-service-.*"} |= "KAFKA"
```

---

## Fluxo completo de uma requisicao

```
1. Cliente faz POST /watch
2. watch-service valida o payload
3. watch-service incrementa Redis: INCR views:movie_id
4. watch-service INSERT no PostgreSQL (watch_history)
5. watch-service publica evento MOVIE_WATCHED no Kafka topic watch.events
6. watch-service retorna 201 ao cliente

(assincronamente, em paralelo ao passo 6):
7. log-processor consome a mensagem do Kafka
8. Acumula no buffer (batch)
9. Quando buffer atinge 100 eventos ou 2s: INSERT no ClickHouse
10. ClickHouse popula a materialized view top_movies_daily

(observabilidade, sempre em paralelo):
11. OTel SDK cria spans para cada operacao
12. Prometheus coleta metricas via /metrics
13. Promtail coleta logs JSON do stdout
```

---

## Escalabilidade

Para producao com 500k usuarios e ~30M eventos/dia:

| Componente | Configuracao recomendada |
|---|---|
| Kafka | 3 brokers, 3 replicas, 6 particoes por topico |
| ClickHouse | Cluster com 2 shards + 2 replicas (ReplicatedMergeTree) |
| log-processor | 3 replicas (cada uma processa particoes diferentes) |
| Microservicos | HPA no Kubernetes, min 2 replicas |
| Redis | Redis Cluster ou ElastiCache |
| PostgreSQL | RDS Multi-AZ ou Aurora |
