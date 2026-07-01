@echo off
setlocal

REM KB Management Site launcher — double-click to start
set KB_SITE=%~dp0
set PORT=5757

REM Check if already running
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL%==0 (
  echo [kb-site] Already running on port %PORT%. Opening browser...
  start "" "http://localhost:%PORT%/"
  goto :eof
)

echo [kb-site] Starting server on port %PORT%...
start "KB-Site" /min cmd /c "cd /d "%KB_SITE%" && node server.js"
timeout /t 2 /nobreak >nul

REM Open browser
start "" "http://localhost:%PORT%/"

echo.
echo [kb-site] Server started. To stop: close the "KB-Site" window, or run stop.bat
echo.
pause
