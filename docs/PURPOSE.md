# Por que cada componente existe

## O problema

Uma plataforma de streaming com 500k usuarios gera eventos constantemente:
- Cada usuario assiste filmes, pausa, volta, curte, cancela assinatura
- Cada microservico executa operacoes que precisam ser auditadas
- Em horario de pico: **~5.000 eventos/segundo**
- Em um dia: **~30 milhoes de eventos**

Esses eventos precisam ser:
1. **Capturados sem impactar o usuario** (nao pode travar o request HTTP)
2. **Persistidos com durabilidade** (nao pode perder eventos se um servico cair)
3. **Consultaveis de forma analitica** (top filmes, usuarios ativos, comportamento)
4. **Observaveis em tempo real** (saber agora se algo esta errado)

---

## Por que cada banco

### ClickHouse — armazenamento principal de logs

**Problema que resolve:** armazenar e consultar dezenas de milhoes de eventos rapidamente.

**Por que nao PostgreSQL para logs?**
- PostgreSQL armazena por linha: para contar eventos por operacao, leria todos os campos de cada linha
- Com 30M eventos/dia, um `SELECT count() GROUP BY operation` demoraria segundos ou minutos
- Escritas concorrentes de alta frequencia causam lock contention

**Por que ClickHouse?**
- Armazenamento **colunar**: `SELECT count() WHERE operation = 'MOVIE_WATCHED'` le so a coluna `operation` — ignora todas as outras
- Throughput de escrita: **500k+ linhas/segundo** em hardware comum
- Compressao nativa: 5-10x menor que PostgreSQL para dados de log
- `LowCardinality` para `ms_name` e `operation` — dictionary encoding automatico
- Materialized views calculam agregacoes em tempo real sem custo de query

**Alternativas consideradas:**
- Elasticsearch: bom para busca full-text, ruim para agregacoes numericas, consome muita RAM
- TimescaleDB: bom, mas ainda baseado em PostgreSQL — nao escala tao bem para escrita massiva
- BigQuery/Redshift: excelentes, mas custo alto e latencia de ingestion maior

### PostgreSQL — dados relacionais

**Problema que resolve:** manter a fonte de verdade dos usuarios, filmes, historico e assinaturas.

**Por que PostgreSQL e nao ClickHouse para isso?**
- ClickHouse nao tem `UPDATE` eficiente, nem `DELETE` por chave primaria, nem foreign keys
- Para saber o plano atual de um usuario, voce precisa de uma linha com estado atual — nao de historico de eventos
- Transacoes ACID sao criticas para pagamentos e assinaturas

**Responsabilidades:**
- Tabela `users` — fonte de verdade do usuario
- Tabela `watch_history` — historico paginavel para o usuario ver
- Tabela `subscriptions` — estado atual da assinatura (ativa/cancelada)
- Tabela `likes` — registro relacional com unique constraint (evita like duplicado)

**PostgreSQL e ClickHouse sao complementares, nao concorrentes.**

### Redis — estado em tempo real

**Problema que resolve:** operacoes de alta frequencia que precisam de resposta em <1ms.

**Por que nao PostgreSQL para isso?**
- `UPDATE views SET count = count + 1 WHERE movie_id = ?` com 5000 req/s causaria lock contention severo
- Verificar `SELECT exists(WHERE user_id = ? AND movie_id = ?)` para cada curtida tambem

**Como o Redis resolve:**
- `INCR views:{movieId}` — atomico, <1ms, sem lock
- `SADD liked:{userId} {movieId}` — Set com O(1) para verificar membro
- `SMEMBERS liked:{userId}` — busca todos os likes de um usuario para filtrar recomendacoes

**Dados no Redis sao volateis por design** — se o Redis cair, o ClickHouse ainda tem o historico completo.

### MinIO — cold storage

**Problema que resolve:** guardar logs apos o TTL de 90 dias do ClickHouse sem perder os dados.

**Por que MinIO?**
- API 100% compativel com S3 da AWS — migrar para producao e so mudar a URL
- Roda localmente sem custo
- Bucket `cold-logs` recebe arquivos Parquet com logs expirados

---

## Por que Kafka e nao chamada direta

**Problema que resolve:** desacoplar o processamento de logs da operacao normal do microservico.

**Sem Kafka (chamada direta ao ClickHouse):**
```
POST /watch → INSERT no ClickHouse → resposta ao cliente
```
- Se o ClickHouse estiver lento, o usuario espera
- Se o ClickHouse cair, o request falha
- O watch-service precisa conhecer o ClickHouse

**Com Kafka:**
```
POST /watch → publica evento → resposta ao cliente (rapido)
                   ↓ (assincronamente)
            log-processor consome → INSERT no ClickHouse
```
- O usuario recebe resposta em ~3ms independente do ClickHouse
- Se o ClickHouse cair, os eventos ficam no Kafka (retencao 7 dias)
- O watch-service nao sabe que o ClickHouse existe

**Kafka tambem permite:**
- Multiplos consumers do mesmo evento (analytics, alertas, ML pipeline)
- Replay de eventos passados se um consumer falhar
- Ordenacao garantida dentro de cada particao

---

## Por que cada ferramenta de observabilidade

### OpenTelemetry — padrao aberto de instrumentacao

**Por que nao SDK proprio de cada ferramenta?**
- Se instrumentar com SDK do Datadog, fica preso ao Datadog
- OpenTelemetry e o padrao da industria — voce instrumenta uma vez e exporta para qualquer backend
- Todos os servicos usam `@opentelemetry/sdk-node` — se trocar de Jaeger para Zipkin, so muda o collector

### Jaeger — traces distribuidos

**Por que traces?**
- Metricas dizem "a latencia P95 subiu para 800ms"
- Traces dizem "o problema e o INSERT no PostgreSQL que esta demorando 750ms"
- Sem traces, voce sabe que algo esta errado mas nao onde

**Por que Jaeger e nao Zipkin ou Datadog?**
- Jaeger e open source e gratuito
- Suporte nativo a OpenTelemetry
- UI excelente para analise de traces

### Prometheus — metricas de series temporais

**Por que series temporais e nao eventos no ClickHouse?**
- Metricas como "requests/segundo" sao agregacoes que mudam a cada segundo
- Prometheus e otimizado para scraping e storage de series temporais
- Alertas com thresholds sao nativos no Prometheus
- Grafana ja tem datasource nativo para Prometheus

**O modelo pull (scraping) e intencional:** se um servico cair, o Prometheus detecta imediatamente (target down). Com push, voce dependeria do servico estar vivo para saber que ele morreu.

### Loki — agregacao de logs

**Por que nao Elasticsearch para logs?**
- Elasticsearch indexa o texto completo de cada linha — consome muita RAM e CPU
- Loki indexa apenas os **labels** (container, servico) e guarda o texto comprimido
- Para 30M eventos/dia, Elasticsearch ficaria caro rapidamente
- Loki e 10-50x mais barato de operar

**Integracao com Grafana:** voce ve metricas, traces e logs na mesma tela, com correlacao automatica (clica num spike de erros → vai direto nos logs daquele momento).

### Grafana — visualizacao unificada

**Por que um dashboard unico?**
- Sem Grafana, voce teria: Prometheus UI para metricas, Jaeger UI para traces, terminal para logs
- Grafana conecta os tres: ao ver um spike no grafico de erros, voce navega para os logs e traces do mesmo periodo com um clique
- Datasources pre-configurados via provisioning — zero configuracao manual apos `docker compose up`

---

## Por que log-processor separado

**Por que nao cada microservico inserir direto no ClickHouse?**

1. **Acoplamento:** cada servico precisaria de configuracao e dependencia do ClickHouse
2. **Batch ineficiente:** cada servico faria 1 INSERT por evento — ruim para ClickHouse
3. **Responsabilidade unica:** microservicos cuidam do dominio de negocio; log-processor cuida de persistencia de logs
4. **Escalabilidade independente:** pode escalar o log-processor separadamente dos microservicos
5. **Retry centralizado:** se o ClickHouse cair, o log-processor gerencia o retry — nenhum microservico precisa se preocupar

---

## Resumo de decisoes

| Decisao | Alternativa Rejeitada | Motivo |
|---|---|---|
| ClickHouse para logs | PostgreSQL | volume e performance analitica |
| Kafka como event bus | chamada HTTP direta | desacoplamento e durabilidade |
| Redis para contadores | PostgreSQL | latencia e throughput |
| Loki para logs | Elasticsearch | custo operacional |
| OpenTelemetry | SDK proprietario | portabilidade de vendor |
| Batch insert no ClickHouse | insert por evento | performance do ClickHouse |
| log-processor separado | insert nos proprios servicos | responsabilidade unica e eficiencia |
