import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

// OTel deve ser inicializado antes de qualquer outra coisa
const sdk = new NodeSDK({
  resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: process.env.SERVICE_NAME ?? 'log-processor' }),
  traceExporter: new OTLPTraceExporter({ url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://otel-collector:4318'}/v1/traces` }),
  instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
});
sdk.start();

import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';
import { createClient } from '@clickhouse/client';
import express from 'express';
import pino from 'pino';
import { Counter, Gauge, register } from 'prom-client';
import { randomUUID } from 'crypto';

// ClickHouse DateTime64 nao aceita ISO 8601 com T/Z — precisa de "YYYY-MM-DD HH:MM:SS.mmm"
function toChDateTime(iso: string): string {
  return iso.replace('T', ' ').replace('Z', '').slice(0, 23);
}

const log = pino({ level: 'info' });

// ── Metricas Prometheus ────────────────────────────────────────────────────────
const eventsProcessed = new Counter({
  name: 'events_processed_total',
  help: 'Total de eventos processados com sucesso',
  labelNames: ['ms_name', 'operation'],
});

const eventsErrors = new Counter({
  name: 'events_errors_total',
  help: 'Total de erros ao processar eventos',
  labelNames: ['ms_name', 'topic'],
});

const clickhouseInserts = new Counter({
  name: 'clickhouse_inserts_total',
  help: 'Total de inserts no ClickHouse',
});

const batchSizeGauge = new Gauge({
  name: 'batch_current_size',
  help: 'Tamanho do batch atual aguardando flush',
});

// ── ClickHouse ────────────────────────────────────────────────────────────────
const ch = createClient({
  host:     `http://${process.env.CLICKHOUSE_HOST ?? 'clickhouse'}:${process.env.CLICKHOUSE_PORT ?? '8123'}`,
  database: process.env.CLICKHOUSE_DB ?? 'logs',
  username: process.env.CLICKHOUSE_USER ?? 'streaming',
  password: process.env.CLICKHOUSE_PASSWORD ?? 'streaming',
});

interface LogEvent {
  log_id:     string;
  timestamp:  string;
  ms_name:    string;
  operation:  string;
  user_id:    string;
  entity_id:  string;
  session_id: string;
  metadata:   string;
  ip:         string;
  device:     string;
}

// Buffer para batch insert
let batch: LogEvent[] = [];
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 2000;

async function flushBatch() {
  if (batch.length === 0) return;

  const toInsert = [...batch];
  batch = [];
  batchSizeGauge.set(0);

  try {
    await ch.insert({
      table: 'events',
      values: toInsert,
      format: 'JSONEachRow',
    });
    clickhouseInserts.inc(toInsert.length);
    log.info({ count: toInsert.length }, 'batch inserido no ClickHouse');
  } catch (err) {
    log.error({ err, count: toInsert.length }, 'erro ao inserir batch no ClickHouse');
    // recolocar no batch para retry
    batch = [...toInsert, ...batch];
    batchSizeGauge.set(batch.length);
  }
}

function addToBatch(event: LogEvent) {
  batch.push(event);
  batchSizeGauge.set(batch.length);
  if (batch.length >= BATCH_SIZE) {
    flushBatch().catch((err) => log.error({ err }, 'erro no flush'));
  }
}

// ── Kafka Consumer ────────────────────────────────────────────────────────────
const TOPICS = ['user.events', 'watch.events', 'like.events', 'payment.events', 'ms.operations'];

const kafka = new Kafka({
  clientId: 'log-processor',
  brokers: [process.env.KAFKA_BROKER ?? 'kafka:9092'],
  retry: { retries: 15, initialRetryTime: 2000 },
});

const consumer: Consumer = kafka.consumer({ groupId: 'log-processor-group' });

async function processMessage({ topic, message }: EachMessagePayload) {
  if (!message.value) return;

  try {
    const raw = JSON.parse(message.value.toString()) as Partial<LogEvent>;

    const event: LogEvent = {
      log_id:     raw.log_id    ?? randomUUID(),
      timestamp:  toChDateTime(raw.timestamp ?? new Date().toISOString()),
      ms_name:    raw.ms_name   ?? 'unknown',
      operation:  raw.operation ?? 'UNKNOWN',
      user_id:    raw.user_id   ?? '',
      entity_id:  raw.entity_id ?? '',
      session_id: raw.session_id ?? '',
      metadata:   typeof raw.metadata === 'string' ? raw.metadata : JSON.stringify(raw.metadata ?? {}),
      ip:         '',
      device:     '',
    };

    // enriquecer metadata
    try {
      const meta = JSON.parse(event.metadata) as Record<string, unknown>;
      event.ip     = String(meta.ip ?? '');
      event.device = String(meta.device ?? '');
    } catch {
      // metadata nao e JSON valido, tudo bem
    }

    addToBatch(event);
    eventsProcessed.inc({ ms_name: event.ms_name, operation: event.operation });

    log.debug({ topic, ms_name: event.ms_name, operation: event.operation }, 'evento processado');
  } catch (err) {
    eventsErrors.inc({ ms_name: 'unknown', topic });
    log.error({ err, topic }, 'erro ao processar mensagem');
  }
}

// ── HTTP para /metrics ────────────────────────────────────────────────────────
const app = express();

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'log-processor', batchSize: batch.length }));
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

// ── Start ────────────────────────────────────────────────────────────────────
async function start() {
  // metrics server
  app.listen(9091, () => log.info('metrics server em :9091'));

  // flush periodico
  setInterval(() => {
    flushBatch().catch((err) => log.error({ err }, 'erro no flush periodico'));
  }, FLUSH_INTERVAL_MS);

  // kafka
  await consumer.connect();
  log.info('kafka consumer conectado');

  for (const topic of TOPICS) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }
  log.info({ topics: TOPICS }, 'inscrito nos topicos');

  await consumer.run({ eachMessage: processMessage });
}

process.on('SIGTERM', async () => {
  log.info('SIGTERM recebido — flushing e encerrando');
  await flushBatch();
  await consumer.disconnect();
  sdk.shutdown().finally(() => process.exit(0));
});

start().catch((err) => { log.error(err); process.exit(1); });
