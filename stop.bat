@echo off
title Chatbot - stop server
echo Stopping the Chatbot server on port 3001 ...
set found=0
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":3001 .*LISTENING"') do (
  set found=1
  taskkill /PID %%p /F >nul && echo Stopped PID %%p.
)
if "%found%"=="0" echo No server is listening on port 3001.
