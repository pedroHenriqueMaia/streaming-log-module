-- PostgreSQL init — Streaming Platform

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Usuarios
CREATE TABLE IF NOT EXISTS users (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       VARCHAR(255) NOT NULL,
    email      VARCHAR(255) UNIQUE NOT NULL,
    plan       VARCHAR(50)  NOT NULL DEFAULT 'free',
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Catalogo de filmes (referencia)
CREATE TABLE IF NOT EXISTS movies (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title       VARCHAR(500) NOT NULL,
    genre       VARCHAR(100),
    duration_s  INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Historico de assistidos
CREATE TABLE IF NOT EXISTS watch_history (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id          UUID NOT NULL REFERENCES users(id),
    movie_id         UUID NOT NULL,
    session_id       VARCHAR(100),
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    progress_pct     SMALLINT DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0
);

-- Likes
CREATE TABLE IF NOT EXISTS likes (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID NOT NULL REFERENCES users(id),
    movie_id   UUID NOT NULL,
    liked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, movie_id)
);

-- Assinaturas
CREATE TABLE IF NOT EXISTS subscriptions (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID NOT NULL REFERENCES users(id),
    plan       VARCHAR(50) NOT NULL,
    status     VARCHAR(20) NOT NULL DEFAULT 'active',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_watch_user     ON watch_history(user_id);
CREATE INDEX IF NOT EXISTS idx_watch_movie    ON watch_history(movie_id);
CREATE INDEX IF NOT EXISTS idx_likes_user     ON likes(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_user      ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);

-- Seed: catalogo de filmes
INSERT INTO movies (id, title, genre, duration_s) VALUES
  ('11111111-1111-1111-1111-111111111111', 'The Matrix',                    'sci-fi',  8160),
  ('22222222-2222-2222-2222-222222222222', 'Inception',                     'sci-fi',  8880),
  ('33333333-3333-3333-3333-333333333333', 'Interstellar',                  'sci-fi',  10140),
  ('44444444-4444-4444-4444-444444444444', 'The Dark Knight',               'action',  9120),
  ('55555555-5555-5555-5555-555555555555', 'Pulp Fiction',                  'drama',   9420),
  ('66666666-6666-6666-6666-666666666666', 'Parasite',                      'drama',   8220),
  ('77777777-7777-7777-7777-777777777777', 'The Shawshank Redemption',      'drama',   8520),
  ('88888888-8888-8888-8888-888888888888', 'The Godfather',                 'drama',   10500),
  ('99999999-9999-9999-9999-999999999999', 'Fight Club',                    'drama',   8220),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Avengers: Endgame',             'action',  10860),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'The Silence of the Lambs',      'thriller',6720),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Spirited Away',                 'animation',7440),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'The Lord of the Rings: ROTK',   'fantasy', 12180),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Joker',                         'drama',   7320),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Dune: Part One',                'sci-fi',  9360)
ON CONFLICT DO NOTHING;
