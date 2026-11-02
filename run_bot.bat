@echo off
title GOMONHUB WhatsApp AI Bot
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%"
echo ====================================================
echo Starting GOMONHUB WhatsApp AI Support Bot...
echo ====================================================
node bot.js
pause
