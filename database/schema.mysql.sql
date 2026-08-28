-- Investment Advisor — MySQL schema.
-- Keep logically identical to schema.sqlite.sql (only dialect syntax may differ).
-- All timestamps are UNIX epoch MILLISECONDS (BIGINT) for cross-dialect portability.
-- JSON-shaped columns are LONGTEXT holding JSON (documented per column).

-- App settings: one JSON value per key (ai, prefs, indicators, providers, schedule...).
-- The ONLY setting not stored here is the DB connection itself (data/config.json).
CREATE TABLE IF NOT EXISTS settings (
  `key`       VARCHAR(64) PRIMARY KEY,
  value       LONGTEXT NOT NULL,
  updated_at  BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per market scan (manual button press or scheduled run).
CREATE TABLE IF NOT EXISTS scan_runs (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  trigger_type    VARCHAR(16) NOT NULL,
  status          VARCHAR(16) NOT NULL,
  started_at      BIGINT NOT NULL,
  finished_at     BIGINT,
  universe_count  INT DEFAULT 0,
  shortlist_count INT DEFAULT 0,
  recs_count      INT DEFAULT 0,
  error           TEXT,
  log             LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every AI recommendation, logged in full so success rate can be measured honestly.
-- Recommendations are SHADOW-TRACKED against real prices even when not taken.
CREATE TABLE IF NOT EXISTS recommendations (
  id               BIGINT PRIMARY KEY AUTO_INCREMENT,
  run_id           BIGINT,
  created_at       BIGINT NOT NULL,
  asset_type       VARCHAR(8) NOT NULL,
  symbol           VARCHAR(32) NOT NULL,
  name             VARCHAR(128),
  side             VARCHAR(8) NOT NULL,
  current_price    DOUBLE,
  entry_low        DOUBLE,
  entry_high       DOUBLE,
  stop_loss        DOUBLE,
  targets          LONGTEXT,
  horizon_min_days INT,
  horizon_max_days INT,
  confidence       DOUBLE,
  risk_reward      DOUBLE,
  rationale        TEXT,
  options_play     LONGTEXT,
  inputs           LONGTEXT,
  status           VARCHAR(16) NOT NULL DEFAULT 'open',
  outcome          LONGTEXT,
  taken            TINYINT NOT NULL DEFAULT 0,
  expires_at       BIGINT,
  INDEX idx_recs_status (status),
  INDEX idx_recs_symbol (symbol),
  CONSTRAINT fk_recs_run FOREIGN KEY (run_id) REFERENCES scan_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Trades the user actually took (linked to the source recommendation when applicable).
CREATE TABLE IF NOT EXISTS trades (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  rec_id       BIGINT,
  created_at   BIGINT NOT NULL,
  asset_type   VARCHAR(8) NOT NULL,
  symbol       VARCHAR(32) NOT NULL,
  side         VARCHAR(8) NOT NULL,
  qty          DOUBLE NOT NULL,
  entry_price  DOUBLE NOT NULL,
  entry_at     BIGINT NOT NULL,
  stop_loss    DOUBLE,
  targets      LONGTEXT,
  status       VARCHAR(16) NOT NULL DEFAULT 'open',
  suggested_stop LONGTEXT,
  health       LONGTEXT,
  option_details LONGTEXT,
  exits        LONGTEXT,
  pnl          DOUBLE,
  pnl_pct      DOUBLE,
  closed_at    BIGINT,
  notes        TEXT,
  INDEX idx_trades_status (status),
  CONSTRAINT fk_trades_rec FOREIGN KEY (rec_id) REFERENCES recommendations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Timeline of notable happenings (stop hit, target hit, trade opened/closed, scan done...).
CREATE TABLE IF NOT EXISTS events (
  id        BIGINT PRIMARY KEY AUTO_INCREMENT,
  at        BIGINT NOT NULL,
  type      VARCHAR(24) NOT NULL,
  ref_type  VARCHAR(16),
  ref_id    BIGINT,
  symbol    VARCHAR(32),
  message   TEXT NOT NULL,
  seen      TINYINT NOT NULL DEFAULT 0,
  INDEX idx_events_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Generic fetch cache (quotes, OHLCV history, news, sentiment, whales) with TTL handled
-- by the app via fetched_at. Keeps us polite to the free data providers.
CREATE TABLE IF NOT EXISTS cache (
  `key`      VARCHAR(255) PRIMARY KEY,
  value      LONGTEXT NOT NULL,
  fetched_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Symbols you're watching (not holding): price alerts + scan priority.
CREATE TABLE IF NOT EXISTS watchlist (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  created_at   BIGINT NOT NULL,
  symbol       VARCHAR(32) NOT NULL,
  yahoo_symbol VARCHAR(32) NOT NULL,
  asset_type   VARCHAR(8) NOT NULL,
  name         VARCHAR(128),
  note         TEXT,
  alert_above  DOUBLE,
  alert_below  DOUBLE,
  alerts_fired LONGTEXT,
  INDEX idx_watch_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- AI usage telemetry: one row per model call (scan, chat, briefing…). Streamed calls
-- may carry ESTIMATED token counts (estimated=1) when the endpoint reports no usage.
CREATE TABLE IF NOT EXISTS ai_usage (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  at                BIGINT NOT NULL,
  task              VARCHAR(32) NOT NULL,
  model             VARCHAR(128),
  prompt_tokens     INT,
  completion_tokens INT,
  total_tokens      INT,
  estimated         TINYINT DEFAULT 0,
  via_failover      TINYINT DEFAULT 0,
  INDEX idx_ai_usage_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
