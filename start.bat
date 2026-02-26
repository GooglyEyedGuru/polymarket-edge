@echo off
title Polymarket Edge Bot
cd /d %~dp0
echo.
echo  ==========================================
echo   Polymarket Edge Bot - Starting
echo  ==========================================
echo.
npx ts-node src/bot/index.ts
echo.
echo  Bot stopped. Press any key to close.
pause > nul
