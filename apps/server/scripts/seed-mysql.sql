-- Scratch data for local MySQL driver work.
--   docker run -d --name dbchat-mysql -e MYSQL_ROOT_PASSWORD=dev \
--     -e MYSQL_DATABASE=dbchat_dev -p 3307:3306 mysql:8
--   docker exec -i dbchat-mysql mysql -uroot -pdev dbchat_dev < apps/server/scripts/seed-mysql.sql
-- Safe to re-run.

DROP VIEW  IF EXISTS paying_users;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  plan       VARCHAR(16)  NOT NULL DEFAULT 'free',
  country    VARCHAR(2),
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  UNIQUE KEY users_email_key (email),
  KEY users_plan_idx (plan)
) ENGINE = InnoDB;

CREATE TABLE orders (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT      NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'paid',
  total_cents INT         NOT NULL,
  placed_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY orders_user_idx (user_id, placed_at),
  CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB;

-- MySQL has no generate_series; a recursive CTE does the same job.
SET SESSION cte_max_recursion_depth = 100000;

INSERT INTO users (email, plan, country, created_at, deleted_at)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 10000)
SELECT
  CONCAT('user', LPAD(n, 6, '0'), '@example.com'),
  ELT(1 + (n % 3), 'free', 'pro', 'team'),
  ELT(1 + (n % 5), 'GB', 'US', 'DE', 'FR', 'JP'),
  NOW() - INTERVAL (n % 365) DAY,
  IF(n % 97 = 0, NOW(), NULL)
FROM seq;

INSERT INTO orders (user_id, status, total_cents, placed_at)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20000)
SELECT
  1 + (n % 10000),
  ELT(1 + (n % 3), 'paid', 'refunded', 'pending'),
  100 + (n * 13) % 50000,
  NOW() - INTERVAL (n % 90) DAY
FROM seq;

CREATE VIEW paying_users AS
SELECT id, email, plan FROM users WHERE plan <> 'free';

ANALYZE TABLE users;
ANALYZE TABLE orders;
