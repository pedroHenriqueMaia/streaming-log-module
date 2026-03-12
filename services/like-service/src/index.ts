import './tracing';

import express from 'express';
import { Kafka } from 'kafkajs';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { Counter, Histogram, register } from 'prom-client';

const log = pino({ level: 'info' });
const SERVICE = process.env.SERVICE_NAME ?? 'like-service';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

const httpTotal = new Counter({ name: 'http_requests_total', help: 'Total HTTP', labelNames: ['method', 'route', 'status', 'service'] });
const httpDuration = new Histogram({ name: 'http_request_duration_seconds', help: 'Duracao HTTP', labelNames: ['method', 'route', 'status', 'service'], buckets: [0.01, 0.05, 0.1, 0.5, 1, 2] });

const kafka = new Kafka({ clientId: SERVICE, brokers: [process.env.KAFKA_BROKER ?? 'kafka:9092'], retry: { retries: 10 } });
const producer = kafka.producer();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

async function publishEvent(userId: string, operation: string, movieId: string) {
  await producer.send({
    topic: 'like.events',
    messages: [{ key: userId, value: JSON.stringify({ log_id: uuidv4(), timestamp: new Date().toISOString(), ms_name: SERVICE, operation, user_id: userId, entity_id: movieId, session_id: uuidv4(), metadata: '{}' }) }],
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

// POST /likes — curtir filme (guarda no Redis)
app.post('/likes', async (req, res) => {
  try {
    const { user_id, movie_id } = req.body as { user_id: string; movie_id: string };
    if (!user_id || !movie_id) return res.status(400).json({ error: 'user_id e movie_id obrigatorios' });

    const key = `likes:${user_id}`;
    const already = await redis.sismember(key, movie_id);
    if (already) return res.status(409).json({ error: 'ja curtiu este filme' });

    await redis.sadd(key, movie_id);
    await redis.incr(`movie:${movie_id}:likes`);
    await publishEvent(user_id, 'MOVIE_LIKED', movie_id);

    log.info({ user_id, movie_id, operation: 'MOVIE_LIKED' }, 'like registrado');
    res.status(201).json({ ok: true, user_id, movie_id });
  } catch (err) {
    log.error({ err }, 'erro ao registrar like');
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /likes — descurtir
app.delete('/likes', async (req, res) => {
  try {
    const { user_id, movie_id } = req.body as { user_id: string; movie_id: string };
    await redis.srem(`likes:${user_id}`, movie_id);
    await redis.decr(`movie:${movie_id}:likes`);
    await publishEvent(user_id, 'MOVIE_UNLIKED', movie_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /likes/:userId — lista de likes
app.get('/likes/:userId', async (req, res) => {
  const liked = await redis.smembers(`likes:${req.params.userId}`);
  res.json({ user_id: req.params.userId, liked_movies: liked });
});

// GET /likes/count/:movieId — total de likes de um filme
app.get('/likes/count/:movieId', async (req, res) => {
  const count = await redis.get(`movie:${req.params.movieId}:likes`);
  res.json({ movie_id: req.params.movieId, likes: parseInt(count ?? '0', 10) });
});

async function start() {
  await producer.connect();
  log.info('kafka producer conectado');
  app.listen(PORT, () => log.info({ port: PORT, service: SERVICE }, 'servico iniciado'));
}

start().catch((err) => { log.error(err); process.exit(1); });
