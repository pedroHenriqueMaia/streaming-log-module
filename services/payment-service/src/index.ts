import './tracing';

import express from 'express';
import { Kafka } from 'kafkajs';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { Counter, Histogram, register } from 'prom-client';

const log = pino({ level: 'info' });
const SERVICE = process.env.SERVICE_NAME ?? 'payment-service';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const httpTotal = new Counter({ name: 'http_requests_total', help: 'Total HTTP', labelNames: ['method', 'route', 'status', 'service'] });
const httpDuration = new Histogram({ name: 'http_request_duration_seconds', help: 'Duracao HTTP', labelNames: ['method', 'route', 'status', 'service'], buckets: [0.01, 0.05, 0.1, 0.5, 1, 2] });

const kafka = new Kafka({ clientId: SERVICE, brokers: [process.env.KAFKA_BROKER ?? 'kafka:9092'], retry: { retries: 10 } });
const producer = kafka.producer();
const db = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://streaming:streaming@postgres:5432/streaming' });

async function publishEvent(userId: string, operation: string, meta: Record<string, unknown>) {
  await producer.send({
    topic: 'payment.events',
    messages: [{ key: userId, value: JSON.stringify({ log_id: uuidv4(), timestamp: new Date().toISOString(), ms_name: SERVICE, operation, user_id: userId, entity_id: userId, session_id: uuidv4(), metadata: JSON.stringify(meta) }) }],
  });
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const l = { method: req.method, route: req.path, status: String(res.statusCode), service: SERVICE };
    httpTotal.inc(l); httpDuration.observe(l, (Date.now() - start) / 1000);
  });
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE }));
app.get('/metrics', async (_req, res) => { res.set('Content-Type', register.contentType); res.send(await register.metrics()); });

// POST /subscriptions — assinar plano
app.post('/subscriptions', async (req, res) => {
  try {
    const { user_id, plan } = req.body as { user_id: string; plan: string };
    if (!user_id || !plan) return res.status(400).json({ error: 'user_id e plan obrigatorios' });

    const validPlans = ['basic', 'standard', 'premium'];
    if (!validPlans.includes(plan)) return res.status(400).json({ error: `plano invalido. Use: ${validPlans.join(', ')}` });

    const subId = uuidv4();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias

    await db.query(
      'INSERT INTO subscriptions (id, user_id, plan, expires_at) VALUES ($1, $2, $3, $4)',
      [subId, user_id, plan, expiresAt],
    );
    await db.query('UPDATE users SET plan = $1 WHERE id = $2', [plan, user_id]);

    await publishEvent(user_id, 'SUBSCRIPTION_CREATED', { plan, sub_id: subId, expires_at: expiresAt });

    log.info({ user_id, plan, operation: 'SUBSCRIPTION_CREATED' }, 'assinatura criada');
    res.status(201).json({ id: subId, user_id, plan, expires_at: expiresAt });
  } catch (err) {
    log.error({ err }, 'erro ao criar assinatura');
    res.status(500).json({ error: String(err) });
  }
});

// GET /subscriptions/:userId
app.get('/subscriptions/:userId', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, plan, status, started_at, expires_at FROM subscriptions WHERE user_id = $1 ORDER BY started_at DESC',
      [req.params.userId],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /subscriptions/:subId — cancelar assinatura
app.delete('/subscriptions/:subId', async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE subscriptions SET status = $1 WHERE id = $2 RETURNING user_id',
      ['cancelled', req.params.subId],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'assinatura nao encontrada' });

    const { user_id } = result.rows[0] as { user_id: string };
    await publishEvent(user_id, 'SUBSCRIPTION_CANCELLED', { sub_id: req.params.subId });

    log.info({ sub_id: req.params.subId, operation: 'SUBSCRIPTION_CANCELLED' }, 'assinatura cancelada');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

async function start() {
  await producer.connect();
  log.info('kafka producer conectado');
  app.listen(PORT, () => log.info({ port: PORT, service: SERVICE }, 'servico iniciado'));
}

start().catch((err) => { log.error(err); process.exit(1); });
