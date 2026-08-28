#!/usr/bin/env bash
# UNIT_TEST.sh — run the Investment Advisor unit-test suite by hand.
#
#   ./UNIT_TEST.sh                 run everything
#   ./UNIT_TEST.sh ladder          run only tests whose name matches "ladder"
#
# Uses Node's built-in test runner — no extra dependencies. The suite is NETWORK-FREE
# and never touches your real database: provider modules are stubbed and DB-backed
# suites run against throwaway SQLite files in the system temp dir.
#
# What's covered: the money-safety gates (validateRec + the options gauntlet),
# ladder P&L, the indicator math + derived reads + memo, the backtest simulator
# (both exit models, slippage/fees, walk-forward), the shadow-tracker state machine
# (incl. option premium tracking and expiry settlement), equity curves, CSV
# parse/write, asset resolution, tool-result packing, and the security guards.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required (the app already needs it) — install Node 20+" >&2
  exit 1
fi

if [ $# -gt 0 ]; then
  exec node --test --test-name-pattern="$1"
fi
exec node --test
