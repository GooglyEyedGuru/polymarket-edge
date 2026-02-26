#!/bin/bash
BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$BOT_DIR/.bot.pid"

if [ ! -f "$PID_FILE" ]; then echo "ℹ️  Bot not running"; exit 0; fi
PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID" && echo "🛑 Bot stopped (PID $PID)"
else
  echo "ℹ️  PID $PID not running"
fi
rm -f "$PID_FILE"
