/**
 * LOAD TEST — comportamento normal de producao
 * 50 usuarios virtuais por 5 minutos
 * Simula fluxo completo: criar conta -> assistir -> curtir -> recomendacao
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SERVICES, randomMovieId, createUser, JSON_HEADERS } from './utils.js';

// Metricas customizadas
const userCreated       = new Counter('users_created');
const watchRecorded     = new Counter('watches_recorded');
const likeRecorded      = new Counter('likes_recorded');
const recoFetched       = new Counter('recommendations_fetched');
const errorRate         = new Rate('error_rate');
const endToEndDuration  = new Trend('end_to_end_duration_ms');

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // warm-up
    { duration: '1m',  target: 50 },   // subida gradual
    { duration: '3m',  target: 50 },   // carga constante
    { duration: '30s', target: 0 },    // descida
  ],
  thresholds: {
    http_req_duration:        ['p(95)<500', 'p(99)<1000'],
    http_req_failed:          ['rate<0.01'],
    error_rate:               ['rate<0.01'],
    end_to_end_duration_ms:   ['p(95)<2000'],
  },
};

export default function () {
  const startTs = Date.now();

  // 1. Criar usuario
  const user = createUser();
  const createRes = http.post(
    `${SERVICES.user}/users`,
    JSON.stringify(user),
    { headers: JSON_HEADERS, tags: { name: 'create_user' } },
  );

  const created = check(createRes, {
    'create user: status 201': (r) => r.status === 201,
    'create user: has id':     (r) => !!r.json('id'),
  });

  if (!created) { errorRate.add(1); return; }
  errorRate.add(0);

  const userId = createRes.json('id');
  userCreated.add(1);

  sleep(0.2);

  // 2. Assistir filme
  const movieId = randomMovieId();
  const watchRes = http.post(
    `${SERVICES.watch}/watch`,
    JSON.stringify({ user_id: userId, movie_id: movieId, device: 'web' }),
    { headers: JSON_HEADERS, tags: { name: 'watch_movie' } },
  );

  check(watchRes, { 'watch: status 201': (r) => r.status === 201 });
  if (watchRes.status === 201) watchRecorded.add(1);

  sleep(0.1);

  // 3. Curtir filme (70% de chance)
  if (Math.random() < 0.7) {
    const likeRes = http.post(
      `${SERVICES.like}/likes`,
      JSON.stringify({ user_id: userId, movie_id: movieId }),
      { headers: JSON_HEADERS, tags: { name: 'like_movie' } },
    );
    check(likeRes, { 'like: status 2xx': (r) => r.status < 300 });
    if (likeRes.status < 300) likeRecorded.add(1);
  }

  sleep(0.1);

  // 4. Buscar recomendacoes
  const recoRes = http.get(
    `${SERVICES.recommendation}/recommendations/${userId}`,
    { tags: { name: 'get_recommendations' } },
  );

  check(recoRes, {
    'reco: status 200':       (r) => r.status === 200,
    'reco: has items':        (r) => Array.isArray(r.json('recommendations')),
  });
  if (recoRes.status === 200) recoFetched.add(1);

  endToEndDuration.add(Date.now() - startTs);

  sleep(Math.random() * 2 + 1); // 1-3s entre iteracoes
}
