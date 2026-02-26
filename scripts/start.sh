#!/bin/bash
BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$BOT_DIR/.bot.pid"
LOCK_FILE="$BOT_DIR/.bot.lock"
LOG_FILE="$BOT_DIR/bot.log"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "⚠️  Another start is already in progress"
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "⚠️  Bot already running (PID $PID)"
    exit 1
  else
    echo "🧹 Stale PID file removed"
    rm -f "$PID_FILE"
  fi
fi

ORPHANS=$(pgrep -f "ts-node.*bot/index" 2>/dev/null)
if [ -n "$ORPHANS" ]; then
  echo "🧹 Killing orphaned processes: $ORPHANS"
  kill -9 $ORPHANS 2>/dev/null
  sleep 1
fi

echo "🎯 Starting PolymarketEdge..." | tee -a "$LOG_FILE"
nohup npx ts-node "$BOT_DIR/src/bot/index.ts" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "✅ Bot started (PID $(cat $PID_FILE)) — logging to bot.log"
