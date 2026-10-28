@echo off
title Chatbot launcher
echo === Chatbot start setup ===
echo.

REM ---- 1) LM Studio ----
where lms >nul 2>nul
if errorlevel 1 (
  echo [WARN] LM Studio CLI ^(lms^) not found on PATH.
  echo        Start LM Studio manually and load a model such as Qwen3 4B.
) else (
  call :lms_up
  if errorlevel 1 (
    echo Starting LM Studio server on port 1234...
    lms server start --port 1234
    timeout /t 3 /nobreak >nul
  ) else (
    echo LM Studio server is running.
  )
  echo Ensuring model qwen3-4b is loaded ^(a cold load can take a minute^) ...
  lms load qwen3-4b --exact 2>nul
)

REM ---- 2) Chatbot server ----
call :health_ok
if not errorlevel 1 (
  echo Chatbot server is already running on port 3001.
) else (
  echo Starting Chatbot server ...
  REM Close the server window when End session stops it; keep it open with
  REM "pause" only when npm exits with an error.
  start "Chatbot server" /D "%~dp0server" cmd /c "npm start || pause"
  call :wait_server
  if errorlevel 1 (
    echo [ERROR] The Chatbot server did not start.
    echo         Check the "Chatbot server" window for details.
  )
)

REM ---- 3) Open the UI ----
start "" "http://localhost:3001"
echo.
echo Chatbot UI: http://localhost:3001
echo Chat needs a model loaded in LM Studio ^(the UI shows a red banner if not^).
pause
exit /b 0

:lms_up
powershell -NoProfile -Command "exit [int](-not (Test-NetConnection 127.0.0.1 -Port 1234 -InformationLevel Quiet -WarningAction SilentlyContinue))"
exit /b %errorlevel%

:wait_server
REM Poll in a single PowerShell process: spawning powershell.exe on every try
REM added ~1s per attempt and made the 30s window too short on slow starts.
powershell -NoProfile -Command "$deadline = (Get-Date).AddSeconds(60); while ((Get-Date) -lt $deadline) { try { Invoke-WebRequest 'http://127.0.0.1:3001/health' -UseBasicParsing -TimeoutSec 3 | Out-Null; exit 0 } catch {} Start-Sleep -Milliseconds 500 }; exit 1"
exit /b %errorlevel%

:health_ok
REM Use 127.0.0.1, not localhost: the server binds IPv4 loopback only, while
REM localhost resolves to ::1 first and Windows PowerShell does not fall back.
powershell -NoProfile -Command "try{ Invoke-WebRequest 'http://127.0.0.1:3001/health' -UseBasicParsing -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }"
exit /b %errorlevel%
