@echo off
setlocal
set PORT=5757

echo [kb-site] Stopping server on port %PORT%...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  taskkill /F /PID %%P >nul 2>&1
  echo [kb-site] Killed PID %%P
)
echo Done.
pause
