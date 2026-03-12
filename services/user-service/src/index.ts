import './tracing'; // deve ser o primeiro import

import express from 'express';
import { Kafka } from 'kafkajs';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { Counter, Histogram, register } from 'prom-client';

const log = pino({ level: 'info' });
const SERVICE = process.env.SERVICE_NAME ?? 'user-service';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── Metricas Prometheus ────────────────────────────────────────────────────────
const httpTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total de requisicoes HTTP',
  labelNames: ['method', 'route', 'status', 'service'],
});

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duracao das requisicoes HTTP em segundos',
  labelNames: ['method', 'route', 'status', 'service'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

// ── Kafka ──────────────────────────────────────────────────────────────────────
const kafka = new Kafka({
  clientId: SERVICE,
  brokers: [(process.env.KAFKA_BROKER ?? 'kafka:9092')],
  retry: { retries: 10, initialRetryTime: 1000 },
});
const producer = kafka.producer();

async function publishEvent(topic: string, userId: string, operation: string, entityId: string, meta: Record<string, unknown>) {
  await producer.send({
    topic,
    messages: [{
      key: userId,
      value: JSON.stringify({
        log_id:     uuidv4(),
        timestamp:  new Date().toISOString(),
        ms_name:    SERVICE,
        operation,
        user_id:    userId,
        entity_id:  entityId,
        session_id: uuidv4(),
        metadata:   JSON.stringify(meta),
      }),
    }],
  });
}

// ── PostgreSQL ─────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://streaming:streaming@postgres:5432/streaming',
});

// ── Express ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Middleware de metricas
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const labels = { method: req.method, route: req.path, status: String(res.statusCode), service: SERVICE };
    httpTotal.inc(labels);
    httpDuration.observe(labels, (Date.now() - start) / 1000);
  });
  next();
});

// ── Rotas ──────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVICE });
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

// POST /users — criar conta
app.post('/users', async (req, res) => {
  try {
    const { name, email } = req.body as { name: string; email: string };
    if (!name || !email) return res.status(400).json({ error: 'name e email obrigatorios' });

    const userId = uuidv4();
    await db.query(
      'INSERT INTO users (id, name, email) VALUES ($1, $2, $3)',
      [userId, name, email],
    );

    await publishEvent('user.events', userId, 'ACCOUNT_CREATED', userId, { name, email });

    log.info({ userId, operation: 'ACCOUNT_CREATED' }, 'usuario criado');
    res.status(201).json({ id: userId, name, email });
  } catch (err) {
    log.error({ err }, 'erro ao criar usuario');
    res.status(500).json({ error: String(err) });
  }
});

// POST /users/login
app.post('/users/login', async (req, res) => {
  try {
    const { email } = req.body as { email: string };
    const result = await db.query<{ id: string; name: string; email: string }>(
      'SELECT id, name, email FROM users WHERE email = $1', [email],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'usuario nao encontrado' });

    const user = result.rows[0];
    await publishEvent('user.events', user.id, 'USER_LOGIN', user.id, { email });

    log.info({ userId: user.id, operation: 'USER_LOGIN' }, 'login realizado');
    res.json(user);
  } catch (err) {
    log.error({ err }, 'erro ao fazer login');
    res.status(500).json({ error: String(err) });
  }
});

// GET /users/:id
app.get('/users/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT id, name, email, plan, created_at FROM users WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'usuario nao encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
async function start() {
  await producer.connect();
  log.info('kafka producer conectado');

  app.listen(PORT, () => {
    log.info({ port: PORT, service: SERVICE }, 'servico iniciado');
  });
}

start().catch((err) => { log.error(err); process.exit(1); });
