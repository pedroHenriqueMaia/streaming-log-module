/**
 * STRESS TEST — encontrar o ponto de quebra do sistema
 * Aumenta VUs progressivamente ate o sistema degradar
 * Permite observar metricas no Grafana em tempo real
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { SERVICES, randomMovieId, createUser, JSON_HEADERS } from './utils.js';

const errorRate        = new Rate('stress_error_rate');
const watchLatency     = new Trend('stress_watch_latency_ms');
const createLatency    = new Trend('stress_create_latency_ms');

export const options = {
  stages: [
    { duration: '30s', target: 25  },   // warm-up suave
    { duration: '1m',  target: 50  },   // carga moderada
    { duration: '1m',  target: 100 },   // carga alta
    { duration: '1m',  target: 150 },   // carga muito alta
    { duration: '2m',  target: 200 },   // ponto de stress
    { duration: '1m',  target: 200 },   // manter no limite
    { duration: '1m',  target: 50  },   // recovery
    { duration: '30s', target: 0   },   // shutdown
  ],
  thresholds: {
    http_req_duration:    ['p(95)<1000', 'p(99)<3000'],
    http_req_failed:      ['rate<0.05'],   // toleramos 5% de erro em stress
    stress_error_rate:    ['rate<0.05'],
  },
};

export default function () {
  // Mix de operacoes para estressar diferentes servicos
  const op = Math.random();

  if (op < 0.3) {
    // 30%: criar usuario + assistir (operacao mais pesada)
    const user = createUser();
    const t1 = Date.now();
    const createRes = http.post(`${SERVICES.user}/users`, JSON.stringify(user), { headers: JSON_HEADERS });
    createLatency.add(Date.now() - t1);

    const ok = check(createRes, { 'create: 201': (r) => r.status === 201 });
    errorRate.add(!ok ? 1 : 0);

    if (ok) {
      const userId = createRes.json('id');
      sleep(0.05);

      const t2 = Date.now();
      const watchRes = http.post(
        `${SERVICES.watch}/watch`,
        JSON.stringify({ user_id: userId, movie_id: randomMovieId(), device: 'smart_tv' }),
        { headers: JSON_HEADERS },
      );
      watchLatency.add(Date.now() - t2);
      errorRate.add(watchRes.status !== 201 ? 1 : 0);
    }

  } else if (op < 0.6) {
    // 30%: buscar recomendacoes (operacao leve)
    const fakeUserId = `user-stress-${Math.floor(Math.random() * 10000)}`;
    const recoRes = http.get(`${SERVICES.recommendation}/recommendations/${fakeUserId}`);
    const ok = check(recoRes, { 'reco: 200': (r) => r.status === 200 });
    errorRate.add(!ok ? 1 : 0);

  } else if (op < 0.8) {
    // 20%: like (operacao Redis, muito rapida)
    const likeRes = http.post(
      `${SERVICES.like}/likes`,
      JSON.stringify({
        user_id:  `user-stress-${Math.floor(Math.random() * 10000)}`,
        movie_id: randomMovieId(),
      }),
      { headers: JSON_HEADERS },
    );
    // 409 e valido (ja curtiu), 201 tambem
    errorRate.add(likeRes.status >= 500 ? 1 : 0);

  } else {
    // 20%: health checks (monitorar se servicos estao respondendo)
    const targets = [
      `${SERVICES.user}/health`,
      `${SERVICES.watch}/health`,
      `${SERVICES.like}/health`,
    ];
    const target = targets[Math.floor(Math.random() * targets.length)];
    const healthRes = http.get(target);
    errorRate.add(healthRes.status !== 200 ? 1 : 0);
  }

  sleep(Math.random() * 0.5); // think time minimo em stress test
}

export function handleSummary(data) {
  return {
    'stdout': JSON.stringify({
      test:    'stress',
      p95:     data.metrics.http_req_duration?.values?.['p(95)'],
      p99:     data.metrics.http_req_duration?.values?.['p(99)'],
      errors:  data.metrics.http_req_failed?.values?.rate,
      reqs:    data.metrics.http_reqs?.values?.count,
    }, null, 2),
  };
}
