@echo off
rem Local scheduled run: peatix (needs login, most important) first, then wpBookings (official site admin),
rem then evemado and jimoty (both blocked from GitHub IPs). Each runs in its own process so one failure
rem or a slow source (jimoty is slow) never blocks the others.
cd /d "%~dp0.."
if not exist logs mkdir logs
echo ---- %DATE% %TIME% ---- >> logs\peatix-scheduled.log
"C:\Program Files\nodejs\node.exe" run.mjs --only=peatix >> logs\peatix-scheduled.log 2>&1
"C:\Program Files\nodejs\node.exe" run.mjs --only=wpBookings >> logs\peatix-scheduled.log 2>&1
"C:\Program Files\nodejs\node.exe" run.mjs --only=evemado >> logs\peatix-scheduled.log 2>&1
"C:\Program Files\nodejs\node.exe" run.mjs --only=jimoty >> logs\peatix-scheduled.log 2>&1
