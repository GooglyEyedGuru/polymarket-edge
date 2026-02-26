#!/bin/bash
BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$BOT_DIR/.bot.pid"
LOG_FILE="$BOT_DIR/bot.log"

if [ -f "$PID_FILE" ] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
  echo "✅ Bot is RUNNING (PID $(cat $PID_FILE))"
else
  echo "🔴 Bot is STOPPED"
fi

echo ""
echo "── Last 20 log lines ──────────────────"
tail -20 "$LOG_FILE" 2>/dev/null || echo "(no log yet)"
