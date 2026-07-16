# Database

SQLite by default (zero setup, single file `data/advisor.db`), MySQL as a first-class
alternative. One async interface in `src/db/index.js` serves both; queries use `?`
placeholders and backtick-quoted identifiers, which both dialects accept.

## Choosing a dialect

`ADVISOR_CONFIG.json` at the project root:

- **SQLite** (default): `"dialect": "sqlite"`, file at `data/advisor.db` (WAL mode).
- **MySQL**: `"dialect": "mysql"` + host/port/user/password/database. Create the
  database and user in MySQL first, then:
  ```
  ./ADVISOR.sh --init-db      # applies database/schema.mysql.sql
  ./ADVISOR.sh --restart
  ```
Also editable from Settings → 🗄️ Database (password masked; same init/restart applies).

## Schema

Two first-class DDL files, kept logically identical:
`database/schema.sqlite.sql` · `database/schema.mysql.sql`

| Table | Holds |
| --- | --- |
| `settings` | One JSON value per settings block (ai, preferences, indicators, providers, schedule, notifications). |
| `scan_runs` | One row per scan: trigger, status, counts, step log. |
| `recommendations` | Every AI rec with levels, ladder, confidence, **risk_reward**, rationale, options play, full input snapshot, lifecycle status + shadow outcome. |
| `trades` | Positions you took: qty/entry/stop/targets, **suggested_stop**, **health** (AI verdict), **option_details**, exits (incl. alert markers), realized P&L. |
| `events` | Activity timeline: rec_new, entry_hit, stop_hit, target_hit, stop_suggest, health, trade_open/close, scan, errors. |
| `cache` | Provider fetch cache with timestamps. |

Timestamps are epoch **milliseconds** (integer) everywhere for cross-dialect portability;
JSON-shaped columns are TEXT/LONGTEXT.

## Migrations

Schema files use `CREATE TABLE IF NOT EXISTS`; columns added after the initial release
are ensured at boot by `migrate()` in `src/db/index.js` (checks `PRAGMA table_info` /
`INFORMATION_SCHEMA`, then `ALTER TABLE ADD COLUMN`) — safe no-op when present. Both
dialects covered.

## ADVISOR.sh database commands

```
./ADVISOR.sh --init-db     # apply schema for the configured dialect (safe to re-run)
./ADVISOR.sh --reset-db    # DESTRUCTIVE: drop + recreate all tables (asks to confirm)
```

## Backup

SQLite: copy `data/advisor.db` (stop the app first, or use `sqlite3 data/advisor.db
".backup backup.db"`). MySQL: `mysqldump investment_advisor`.
