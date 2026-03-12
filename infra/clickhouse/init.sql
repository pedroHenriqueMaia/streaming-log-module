-- ClickHouse init — Streaming Platform Log Module

CREATE DATABASE IF NOT EXISTS logs;

-- Tabela principal de eventos (logs)
CREATE TABLE IF NOT EXISTS logs.events
(
    log_id      UUID            DEFAULT generateUUIDv4(),
    timestamp   DateTime64(3)   DEFAULT now64(),
    ms_name     LowCardinality(String),
    operation   LowCardinality(String),
    user_id     String,
    entity_id   String,
    session_id  String,
    metadata    String,         -- JSON stringificado
    ip          String,
    device      LowCardinality(String),

    INDEX idx_user_id   user_id   TYPE bloom_filter GRANULARITY 1,
    INDEX idx_operation operation TYPE set(50)       GRANULARITY 1,
    INDEX idx_ms_name   ms_name   TYPE set(20)       GRANULARITY 1
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, ms_name, user_id)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- View materializada: contagem de eventos por servico/hora
CREATE MATERIALIZED VIEW IF NOT EXISTS logs.events_by_service_hourly
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, ms_name, operation)
AS SELECT
    toStartOfHour(timestamp) AS hour,
    ms_name,
    operation,
    count() AS total
FROM logs.events
GROUP BY hour, ms_name, operation;

-- View materializada: filmes mais assistidos por dia
CREATE MATERIALIZED VIEW IF NOT EXISTS logs.top_movies_daily
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMMDD(day)
ORDER BY (day, movie_id)
AS SELECT
    toDate(timestamp) AS day,
    entity_id          AS movie_id,
    count()            AS watch_count
FROM logs.events
WHERE operation = 'MOVIE_WATCHED'
GROUP BY day, entity_id;

-- View materializada: usuarios ativos por dia
CREATE MATERIALIZED VIEW IF NOT EXISTS logs.active_users_daily
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY day
AS SELECT
    toDate(timestamp)    AS day,
    uniqState(user_id)   AS unique_users_state
FROM logs.events
GROUP BY day;
