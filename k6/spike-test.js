/**
 * SPIKE TEST — simula pico repentino (lancamento de serie, horario nobre)
 * Sobe de 10 para 500 VUs em 30s, mantem por 1 minuto, depois desce
 * Permite ver como o sistema se comporta em picos de acesso
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { SERVICES, randomMovieId, JSON_HEADERS } from './utils.js';

const spikeErrors = new Rate('spike_error_rate');

export const options = {
  stages: [
    { duration: '10s', target: 10  },   // estado normal
    { duration: '30s', target: 500 },   // SPIKE: pico de lancamento
    { duration: '1m',  target: 500 },   // mantém o pico
    { duration: '30s', target: 10  },   // retorno ao normal
    { duration: '30s', target: 0   },   // shutdown
  ],
  thresholds: {
    http_req_failed:  ['rate<0.10'],  // durante spike, toleramos 10% de erro
    spike_error_rate: ['rate<0.10'],
  },
};

// IDs de usuarios pr-existentes (evita criar usuarios durante o spike)
const EXISTING_USERS = Array.from({ length: 1000 }, (_, i) => `pre-user-${i}`);

function randomExistingUser() {
  return EXISTING_USERS[Math.floor(Math.random() * EXISTING_USERS.length)];
}

export default function () {
  const userId = randomExistingUser();
  const movieId = randomMovieId();

  // Durante o spike: operacoes simples e leves (assistir + like)
  // Simula todos querendo ver o episodio novo ao mesmo tempo

  const watchRes = http.post(
    `${SERVICES.watch}/watch`,
    JSON.stringify({ user_id: userId, movie_id: movieId, device: 'smart_tv' }),
    { headers: JSON_HEADERS, tags: { name: 'spike_watch' } },
  );

  const ok = check(watchRes, {
    'spike watch: nao explodiu': (r) => r.status < 500,
    'spike watch: respondeu':    (r) => r.timings.duration < 5000,
  });
  spikeErrors.add(!ok ? 1 : 0);

  // Sem sleep intencional — simular acesso simultaneo agressivo
  sleep(0.1);
}

export function handleSummary(data) {
  const p95     = data.metrics.http_req_duration?.values?.['p(95)'];
  const errRate = data.metrics.http_req_failed?.values?.rate;
  const reqs    = data.metrics.http_reqs?.values?.count;

  console.log('\n=== SPIKE TEST SUMMARY ===');
  console.log(`Total requests: ${reqs}`);
  console.log(`P95 latency: ${p95?.toFixed(0)}ms`);
  console.log(`Error rate: ${(errRate * 100)?.toFixed(2)}%`);
  console.log('==========================\n');

  return {};
}
