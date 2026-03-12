import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost';

export const SERVICES = {
  user:           __ENV.USER_SERVICE_URL    || `${BASE_URL}:3001`,
  watch:          __ENV.WATCH_SERVICE_URL   || `${BASE_URL}:3002`,
  like:           __ENV.LIKE_SERVICE_URL    || `${BASE_URL}:3003`,
  payment:        __ENV.PAYMENT_SERVICE_URL || `${BASE_URL}:3004`,
  recommendation: __ENV.RECO_SERVICE_URL    || `${BASE_URL}:3005`,
};

export const MOVIES = [
  { id: '11111111-1111-1111-1111-111111111111', title: 'The Matrix' },
  { id: '22222222-2222-2222-2222-222222222222', title: 'Inception' },
  { id: '33333333-3333-3333-3333-333333333333', title: 'Interstellar' },
  { id: '44444444-4444-4444-4444-444444444444', title: 'The Dark Knight' },
  { id: '55555555-5555-5555-5555-555555555555', title: 'Pulp Fiction' },
  { id: '66666666-6666-6666-6666-666666666666', title: 'Parasite' },
  { id: '77777777-7777-7777-7777-777777777777', title: 'The Shawshank Redemption' },
  { id: '88888888-8888-8888-8888-888888888888', title: 'The Godfather' },
  { id: '99999999-9999-9999-9999-999999999999', title: 'Fight Club' },
  { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', title: 'Avengers: Endgame' },
  { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', title: 'The Silence of the Lambs' },
  { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', title: 'Spirited Away' },
  { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', title: 'The Lord of the Rings: ROTK' },
  { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', title: 'Joker' },
  { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', title: 'Dune: Part One' },
];

export const MOVIE_IDS = MOVIES.map(m => m.id);

export const PLANS = ['basic', 'standard', 'premium'];

export function randomMovieId() {
  return MOVIE_IDS[Math.floor(Math.random() * MOVIE_IDS.length)];
}

export function randomPlan() {
  return PLANS[Math.floor(Math.random() * PLANS.length)];
}

export function createUser() {
  const id = uuidv4().substring(0, 8);
  return {
    name:  `User ${id}`,
    email: `user_${id}@streaming.test`,
  };
}

export const JSON_HEADERS = { 'Content-Type': 'application/json' };
