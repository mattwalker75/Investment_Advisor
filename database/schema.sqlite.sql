-- Investment Advisor — SQLite schema.
-- Keep logically identical to schema.mysql.sql (only dialect syntax may differ).
-- All timestamps are UNIX epoch MILLISECONDS (INTEGER) for cross-dialect portability.
-- JSON-shaped columns are TEXT holding JSON (documented per column).

-- App settings: one JSON value per key (ai, prefs, indicators, providers, schedule...).
-- The ONLY setting not stored here is the DB connection itself (data/config.json).
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,             -- JSON
  updated_at  INTEGER NOT NULL
);

-- One row per market scan (manual button press or scheduled run).
CREATE TABLE IF NOT EXISTS scan_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type    TEXT NOT NULL,         -- 'manual' | 'scheduled'
  status          TEXT NOT NULL,         -- 'running' | 'done' | 'error'
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  universe_count  INTEGER DEFAULT 0,     -- symbols considered
  shortlist_count INTEGER DEFAULT 0,     -- symbols passed to the AI
  recs_count      INTEGER DEFAULT 0,     -- recommendations produced
  error           TEXT,
  log             TEXT                   -- JSON array of step log lines
);

-- Every AI recommendation, logged in full so success rate can be measured honestly.
-- Recommendations are SHADOW-TRACKED against real prices even when not taken.
CREATE TABLE IF NOT EXISTS recommendations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           INTEGER REFERENCES scan_runs(id),
  created_at       INTEGER NOT NULL,
  asset_type       TEXT NOT NULL,        -- 'stock' | 'crypto'
  symbol           TEXT NOT NULL,
  name             TEXT,
  side             TEXT NOT NULL,        -- 'buy' | 'sell'
  current_price    REAL,                 -- price at recommendation time
  entry_low        REAL,                 -- buy-zone bottom
  entry_high       REAL,                 -- buy-zone top
  stop_loss        REAL,
  targets          TEXT,                 -- JSON [{price, sell_pct}] laddered exits
  horizon_min_days INTEGER,              -- rough estimated time in trade
  horizon_max_days INTEGER,
  confidence       REAL,                 -- 0..1 from the model
  risk_reward      REAL,                 -- reward:risk ratio (weighted targets vs stop)
  rationale        TEXT,
  options_play     TEXT,                 -- JSON {strategy, expiry, strike(s), note} or NULL
  inputs           TEXT,                 -- JSON snapshot of indicators/news/sentiment fed to the AI
  status           TEXT NOT NULL DEFAULT 'open',
                                         -- 'open' (waiting for entry) | 'tracking' (entry hit, shadow)
                                         -- | 'stopped' | 'target_hit' | 'expired' | 'closed'
  outcome          TEXT,                 -- JSON {entry_hit_at, exit_price, exit_at, pnl_pct, notes}
  taken            INTEGER NOT NULL DEFAULT 0,  -- 1 once the user takes the trade
  expires_at       INTEGER               -- entry never hit by this time -> 'expired'
);
CREATE INDEX IF NOT EXISTS idx_recs_status ON recommendations(status);
CREATE INDEX IF NOT EXISTS idx_recs_symbol ON recommendations(symbol);

-- Trades the user actually took (linked to the source recommendation when applicable).
CREATE TABLE IF NOT EXISTS trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  rec_id       INTEGER REFERENCES recommendations(id),
  created_at   INTEGER NOT NULL,
  asset_type   TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  side         TEXT NOT NULL,            -- 'buy' | 'sell' (short)
  qty          REAL NOT NULL,
  entry_price  REAL NOT NULL,
  entry_at     INTEGER NOT NULL,
  stop_loss    REAL,
  targets      TEXT,                     -- JSON [{price, sell_pct}] (editable copy from the rec)
  status       TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
  suggested_stop TEXT,                   -- JSON {price, basis, at} — advisor's current stop suggestion
  health       TEXT,                     -- JSON {action, urgency, note, checked_at} — latest AI health check
  option_details TEXT,                   -- JSON {type:'call'|'put', strike, expiry, strategy} when asset_type='option'
  exits        TEXT,                     -- JSON [{at, price, qty, reason}] partial/final exits
  pnl          REAL,                     -- realized P&L (filled when closed)
  pnl_pct      REAL,
  closed_at    INTEGER,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

-- Timeline of notable happenings (stop hit, target hit, trade opened/closed, scan done...).
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  type      TEXT NOT NULL,               -- 'rec_new'|'entry_hit'|'stop_hit'|'target_hit'|'trade_open'|'trade_close'|'scan'|'error'
  ref_type  TEXT,                        -- 'recommendation' | 'trade' | 'scan'
  ref_id    INTEGER,
  symbol    TEXT,
  message   TEXT NOT NULL,
  seen      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);

-- Generic fetch cache (quotes, OHLCV history, news, sentiment, whales) with TTL handled
-- by the app via fetched_at. Keeps us polite to the free data providers.
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,              -- JSON
  fetched_at INTEGER NOT NULL
);

-- Symbols you're watching (not holding): price alerts + scan priority.
CREATE TABLE IF NOT EXISTS watchlist (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   INTEGER NOT NULL,
  symbol       TEXT NOT NULL,             -- display symbol (AAPL, BTC)
  yahoo_symbol TEXT NOT NULL,             -- quote/candle ticker (AAPL, BTC-USD)
  asset_type   TEXT NOT NULL,             -- 'stock' | 'crypto'
  name         TEXT,
  note         TEXT,
  alert_above  REAL,                      -- notify when price crosses above
  alert_below  REAL,                      -- notify when price crosses below
  alerts_fired TEXT                       -- JSON {above_at, below_at} de-dup markers
);
CREATE INDEX IF NOT EXISTS idx_watch_symbol ON watchlist(symbol);

-- AI usage telemetry: one row per model call (scan, chat, briefing…). Streamed calls
-- may carry ESTIMATED token counts (estimated=1) when the endpoint reports no usage.
CREATE TABLE IF NOT EXISTS ai_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                INTEGER NOT NULL,
  task              TEXT NOT NULL,           -- 'scan' | 'light' | 'chat' | 'test' | …
  model             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  estimated         INTEGER DEFAULT 0,       -- 1 = counts estimated (endpoint sent no usage)
  via_failover      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage(at);
