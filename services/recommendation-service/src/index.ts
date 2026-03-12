import './tracing';

import express from 'express';
import { Kafka } from 'kafkajs';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { Counter, Histogram, register } from 'prom-client';

const log = pino({ level: 'info' });
const SERVICE = process.env.SERVICE_NAME ?? 'recommendation-service';
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// filmes do catalog (mock para nao depender de chamada externa)
const MOVIE_CATALOG = [
  '11111111-1111-1111-1111-111111111111', // The Matrix
  '22222222-2222-2222-2222-222222222222', // Inception
  '33333333-3333-3333-3333-333333333333', // Interstellar
  '44444444-4444-4444-4444-444444444444', // The Dark Knight
  '55555555-5555-5555-5555-555555555555', // Pulp Fiction
  '66666666-6666-6666-6666-666666666666', // Parasite
  '77777777-7777-7777-7777-777777777777', // The Shawshank Redemption
  '88888888-8888-8888-8888-888888888888', // The Godfather
  '99999999-9999-9999-9999-999999999999', // Fight Club
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', // Avengers: Endgame
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', // The Silence of the Lambs
  'cccccccc-cccc-cccc-cccc-cccccccccccc', // Spirited Away
  'dddddddd-dddd-dddd-dddd-dddddddddddd', // The Lord of the Rings: ROTK
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', // Joker
  'ffffffff-ffff-ffff-ffff-ffffffffffff', // Dune: Part One
];

const httpTotal = new Counter({ name: 'http_requests_total', help: 'Total HTTP', labelNames: ['method', 'route', 'status', 'service'] });
const httpDuration = new Histogram({ name: 'http_request_duration_seconds', help: 'Duracao HTTP', labelNames: ['method', 'route', 'status', 'service'], buckets: [0.01, 0.05, 0.1, 0.5, 1, 2] });

const kafka = new Kafka({ clientId: SERVICE, brokers: [process.env.KAFKA_BROKER ?? 'kafka:9092'], retry: { retries: 10 } });
const producer = kafka.producer();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

async function publishEvent(userId: string, operation: string, meta: Record<string, unknown>) {
  await producer.send({
    topic: 'ms.operations',
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

// GET /recommendations/:userId — retorna filmes recomendados
app.get('/recommendations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(String(req.query.limit ?? '10'), 10);

    // pega filmes mais vistos do Redis e exclui os que o usuario ja curtiu
    const liked = await redis.smembers(`likes:${userId}`);
    const reco = MOVIE_CATALOG
      .filter((m) => !liked.includes(m))
      .slice(0, limit);

    await publishEvent(userId, 'RECO_GENERATED', { count: reco.length, algorithm: 'collaborative-filter-v1' });

    log.info({ userId, count: reco.length, operation: 'RECO_GENERATED' }, 'recomendacoes geradas');
    res.json({ user_id: userId, recommendations: reco, algorithm: 'collaborative-filter-v1' });
  } catch (err) {
    log.error({ err }, 'erro ao gerar recomendacoes');
    res.status(500).json({ error: String(err) });
  }
});

// POST /recommendations/:userId/click — registro de clique em recomendacao
app.post('/recommendations/:userId/click', async (req, res) => {
  try {
    const { userId } = req.params;
    const { movie_id } = req.body as { movie_id: string };
    await publishEvent(userId, 'RECO_CLICKED', { movie_id });
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
