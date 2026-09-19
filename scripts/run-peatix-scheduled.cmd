@echo off
cd /d "%~dp0.."
echo ---- %DATE% %TIME% ---- >> logs\peatix-scheduled.log
"C:\Program Files\nodejs\node.exe" run.mjs --only=peatix >> logs\peatix-scheduled.log 2>&1
