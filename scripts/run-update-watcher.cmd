@echo off
rem Dashboard "update" button receiver. Keeps running; restarts itself if the process ever exits.
cd /d "%~dp0.."
if not exist logs mkdir logs
:again
echo ---- %DATE% %TIME% start ---- >> logs\update-watcher.log
"C:\Program Files\nodejs\node.exe" scripts\update-watcher.mjs >> logs\update-watcher.log 2>&1
timeout /t 30 /nobreak >nul
goto again
