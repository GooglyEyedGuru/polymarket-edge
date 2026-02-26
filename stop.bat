@echo off
echo Sending shutdown signal to Polymarket Edge Bot...
curl -s -X POST http://localhost:3001/shutdown
echo.
echo Done. Bot is shutting down gracefully.
