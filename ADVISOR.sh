#!/usr/bin/env bash
# =============================================================================
#  Investment Advisor — control script (the front door, like JARVIS.sh)
#
#  An AI-powered stock & crypto trading advisor. Local-first Node.js app with a
#  SQLite (default) or MySQL backend and any OpenAI-compatible model (OpenAI,
#  Ollama, LiteLLM, LM Studio) doing the analysis.
#
#  Usage:  ./ADVISOR.sh <command>
#
#    --setup       Install npm dependencies, create ADVISOR_CONFIG.json (SQLite
#                  default), and initialize the database schema.
#    --start       Start the app (background). UI: http://localhost:8210
#    --stop        Stop the app.
#    --restart     Stop + start.
#    --status      Is it running? Which DB dialect? Port? PID?
#    --logs        Tail the app log (Ctrl-C to detach).
#    --init-db     (Re)apply the schema for the configured dialect — safe to
#                  re-run; only creates what's missing (CREATE TABLE IF NOT EXISTS).
#    --reset-db    DESTRUCTIVE: drop and recreate all tables (asks to confirm).
#    --help        This text.
#
#  Database dialect lives in ADVISOR_CONFIG.json ("sqlite" default, or "mysql"
#  with connection details). Schemas: database/schema.sqlite.sql / schema.mysql.sql.
#  Everything else (AI endpoint/model/keys, preferences, indicators, schedule)
#  is stored IN the database and edited from the web UI's Settings tab.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${ADVISOR_PORT:-8210}"
PID_FILE="data/advisor.pid"
LOG_FILE="data/advisor.log"

C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_RESET=$'\033[0m'
info()  { echo "${C_BOLD}[advisor]${C_RESET} $*"; }
ok()    { echo "${C_GREEN}[ok]${C_RESET} $*"; }
warn()  { echo "${C_YELLOW}[warn]${C_RESET} $*"; }
err()   { echo "${C_RED}[error]${C_RESET} $*" >&2; }

require_node() {
  command -v node >/dev/null 2>&1 || { err "Node.js is required (https://nodejs.org). Not found on PATH."; exit 1; }
}

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && { echo "$pid"; return 0; }
  rm -f "$PID_FILE"; return 1
}

cmd_setup() {
  require_node
  info "SETUP: installing npm dependencies..."
  npm install
  mkdir -p data
  if [ ! -f ADVISOR_CONFIG.json ]; then
    if [ -f ADVISOR_CONFIG_template.json ]; then
      cp ADVISOR_CONFIG_template.json ADVISOR_CONFIG.json
    else
      cat > ADVISOR_CONFIG.json <<'EOF'
{
  "_comment": "Database connection (the one setting that can't live in the DB). dialect: 'sqlite' (default, zero-setup) or 'mysql'. Re-run ./ADVISOR.sh --init-db after changing.",
  "db": {
    "dialect": "sqlite",
    "sqlite": { "file": "data/advisor.db" },
    "mysql":  { "host": "127.0.0.1", "port": 3306, "user": "advisor", "password": "", "database": "investment_advisor" }
  }
}
EOF
    fi
    ok "Created ADVISOR_CONFIG.json (SQLite default)."
  else
    info "ADVISOR_CONFIG.json already exists — keeping it."
  fi
  node scripts/init-db.js
  ok "SETUP complete. Next:  ./ADVISOR.sh --start"
}

cmd_start() {
  require_node
  if pid="$(running_pid)"; then warn "Already running (pid $pid) — http://localhost:${PORT}"; return 0; fi
  [ -d node_modules ] || { err "Dependencies missing. Run:  ./ADVISOR.sh --setup"; exit 1; }
  [ -f ADVISOR_CONFIG.json ] || { err "ADVISOR_CONFIG.json missing. Run:  ./ADVISOR.sh --setup"; exit 1; }
  mkdir -p data
  info "Starting Investment Advisor on port ${PORT}..."
  PORT="$PORT" nohup node server.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if pid="$(running_pid)"; then
    ok "Running (pid $pid)."
    echo "${C_BOLD}  Web UI:${C_RESET}  http://localhost:${PORT}"
    echo "  Logs:    ./ADVISOR.sh --logs"
  else
    err "Failed to start — last log lines:"; tail -n 20 "$LOG_FILE" 2>/dev/null || true; exit 1
  fi
}

cmd_stop() {
  if pid="$(running_pid)"; then
    info "Stopping (pid $pid)..."
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    ok "Stopped."
  else
    warn "Not running."
  fi
}

cmd_status() {
  local dialect="unknown"
  [ -f ADVISOR_CONFIG.json ] && dialect="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("ADVISOR_CONFIG.json","utf8")).db.dialect)' 2>/dev/null || echo unknown)"
  if pid="$(running_pid)"; then
    ok "RUNNING (pid $pid) — http://localhost:${PORT}   [db: ${dialect}]"
  else
    warn "STOPPED   [db: ${dialect}]"
  fi
}

cmd_logs() { touch "$LOG_FILE"; tail -n 50 -f "$LOG_FILE"; }

cmd_init_db()  { require_node; node scripts/init-db.js; }
cmd_reset_db() {
  require_node
  warn "This will DROP ALL TABLES and re-create them — recommendations, trades, settings, everything."
  read -r -p "Type 'reset' to confirm: " answer
  [ "$answer" = "reset" ] || { info "Aborted."; exit 0; }
  node scripts/init-db.js --reset
}

case "${1:---help}" in
  --setup)    cmd_setup ;;
  --start)    cmd_start ;;
  --stop)     cmd_stop ;;
  --restart)  cmd_stop; cmd_start ;;
  --status)   cmd_status ;;
  --logs)     cmd_logs ;;
  --init-db)  cmd_init_db ;;
  --reset-db) cmd_reset_db ;;
  --help|-h|*) sed -n '2,26p' "$0" | sed 's/^#//' ;;
esac
