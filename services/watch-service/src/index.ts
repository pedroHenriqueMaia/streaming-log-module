import './tracing';

import express from 'express';
import { Kafka } from 'kafkajs';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { Counter, Histogram, register } from 'prom-client';

const log = pino({ level: 'info' });
const SERVICE = process.env.SERVICE_NAME ?? 'watch-service';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const httpTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total requisicoes HTTP',
  labelNames: ['method', 'route', 'status', 'service'],
});
const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duracao HTTP em segundos',
  labelNames: ['method', 'route', 'status', 'service'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

const kafka = new Kafka({ clientId: SERVICE, brokers: [process.env.KAFKA_BROKER ?? 'kafka:9092'], retry: { retries: 10 } });
const producer = kafka.producer();

const db = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgresql://streaming:streaming@postgres:5432/streaming' });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

async function publishEvent(userId: string, operation: string, movieId: string, meta: Record<string, unknown>) {
  await producer.send({
    topic: 'watch.events',
    messages: [{
      key: userId,
      value: JSON.stringify({
        log_id: uuidv4(), timestamp: new Date().toISOString(),
        ms_name: SERVICE, operation, user_id: userId,
        entity_id: movieId, session_id: meta.session_id ?? uuidv4(),
        metadata: JSON.stringify(meta),
      }),
    }],
  });
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const labels = { method: req.method, route: req.path, status: String(res.statusCode), service: SERVICE };
    httpTotal.inc(labels);
    httpDuration.observe(labels, (Date.now() - start) / 1000);
  });
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE }));
app.get('/metrics', async (_req, res) => { res.set('Content-Type', register.contentType); res.send(await register.metrics()); });

// POST /watch — registrar inicio de assistir
app.post('/watch', async (req, res) => {
  try {
    const { user_id, movie_id, session_id } = req.body as { user_id: string; movie_id: string; session_id?: string };
    if (!user_id || !movie_id) return res.status(400).json({ error: 'user_id e movie_id obrigatorios' });

    const sid = session_id ?? uuidv4();

    await db.query(
      'INSERT INTO watch_history (user_id, movie_id, session_id) VALUES ($1, $2, $3)',
      [user_id, movie_id, sid],
    );

    // cache: incrementa contagem de views do filme
    await redis.incr(`movie:${movie_id}:views`);

    await publishEvent(user_id, 'MOVIE_WATCHED', movie_id, { session_id: sid, device: req.body.device ?? 'web' });

    log.info({ user_id, movie_id, operation: 'MOVIE_WATCHED' }, 'watch registrado');
    res.status(201).json({ session_id: sid, movie_id, user_id });
  } catch (err) {
    log.error({ err }, 'erro ao registrar watch');
    res.status(500).json({ error: String(err) });
  }
});

// POST /watch/pause
app.post('/watch/pause', async (req, res) => {
  try {
    const { user_id, movie_id, progress_pct, session_id } = req.body as Record<string, string | number>;
    await db.query(
      'UPDATE watch_history SET progress_pct = $1 WHERE session_id = $2',
      [progress_pct, session_id],
    );
    await publishEvent(String(user_id), 'MOVIE_PAUSED', String(movie_id), { session_id, progress_pct });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /watch/history/:userId
app.get('/watch/history/:userId', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT movie_id, session_id, started_at, progress_pct FROM watch_history WHERE user_id = $1 ORDER BY started_at DESC LIMIT 50',
      [req.params.userId],
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /watch/views/:movieId — views do filme (cache Redis)
app.get('/watch/views/:movieId', async (req, res) => {
  const views = await redis.get(`movie:${req.params.movieId}:views`);
  res.json({ movie_id: req.params.movieId, views: parseInt(views ?? '0', 10) });
});

async function start() {
  await producer.connect();
  log.info('kafka producer conectado');
  app.listen(PORT, () => log.info({ port: PORT, service: SERVICE }, 'servico iniciado'));
}

start().catch((err) => { log.error(err); process.exit(1); });
