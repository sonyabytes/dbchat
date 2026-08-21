-- Scratch data for local driver work.
--   createdb dbchat_dev && psql dbchat_dev -f apps/server/scripts/seed-pg.sql
-- Safe to re-run: everything is dropped first.

DROP VIEW IF EXISTS paying_users;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id          bigserial PRIMARY KEY,
  email       text        NOT NULL,
  plan        text        NOT NULL DEFAULT 'free',
  country     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_plan_idx ON users (plan);

CREATE TABLE products (
  id          bigserial PRIMARY KEY,
  sku         text        NOT NULL,
  name        text        NOT NULL,
  price_cents integer     NOT NULL,
  active      boolean     NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX products_sku_key ON products (sku);

CREATE TABLE orders (
  id          bigserial PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'paid',
  total_cents integer     NOT NULL,
  placed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON orders (user_id, placed_at DESC);

CREATE TABLE order_items (
  id         bigserial PRIMARY KEY,
  order_id   bigint  NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id bigint  NOT NULL REFERENCES products (id),
  quantity   integer NOT NULL DEFAULT 1
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

INSERT INTO users (email, plan, country, created_at, deleted_at)
SELECT
  'user' || lpad(g::text, 6, '0') || '@example.com',
  (ARRAY['free', 'pro', 'team'])[1 + (g % 3)],
  (ARRAY['GB', 'US', 'DE', 'FR', 'JP'])[1 + (g % 5)],
  now() - (g % 365) * interval '1 day',
  CASE WHEN g % 97 = 0 THEN now() ELSE NULL END
FROM generate_series(1, 10000) AS g;

INSERT INTO products (sku, name, price_cents, active)
SELECT
  'SKU-' || lpad(g::text, 5, '0'),
  'Product ' || g,
  500 + (g * 37) % 20000,
  g % 11 <> 0
FROM generate_series(1, 500) AS g;

INSERT INTO orders (user_id, status, total_cents, placed_at)
SELECT
  1 + (g % 10000),
  (ARRAY['paid', 'refunded', 'pending'])[1 + (g % 3)],
  100 + (g * 13) % 50000,
  now() - (g % 90) * interval '1 day'
FROM generate_series(1, 20000) AS g;

INSERT INTO order_items (order_id, product_id, quantity)
SELECT 1 + (g % 20000), 1 + (g % 500), 1 + (g % 4)
FROM generate_series(1, 40000) AS g;

CREATE VIEW paying_users AS
SELECT id, email, plan FROM users WHERE plan <> 'free';

ANALYZE users;
ANALYZE products;
ANALYZE orders;
ANALYZE order_items;
