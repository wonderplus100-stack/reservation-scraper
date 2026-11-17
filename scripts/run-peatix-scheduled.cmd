@echo off
rem Local scheduled run: peatix (needs login, most important) first, then wpBookings (official site admin),
rem then evemado and jimoty (both blocked from GitHub IPs). Each runs in its own process so one failure
rem or a slow source (jimoty is slow) never blocks the others.
cd /d "%~dp0.."
if not exist logs mkdir logs
echo ---- %DATE% %TIME% ---- >> logs\peatix-scheduled.log
rem If a manual update (dashboard button, scripts\update-watcher.mjs) is running today, skip this round (they share the Peatix browser profile).
if exist data\manual-update.lock (
  forfiles /p data /m manual-update.lock /d 0 >nul 2>&1 && (
    echo skipped: manual update is running >> logs\peatix-scheduled.log
    exit /b 0
  )
)
rem Pull the latest improvements from GitHub first, so every PC runs the same (latest) code.
rem Fast-forward only: it never overwrites local changes; a failure is ignored and the current code is used.
git pull --ff-only --quiet >> logs\peatix-scheduled.log 2>&1
call npm install --no-audit --no-fund --silent >> logs\peatix-scheduled.log 2>&1
"C:\Program Files\nodejs\node.exe" run.mjs --only=peatix >> logs\peatix-scheduled.log 2>&1
"C:\Program Files\nodejs\node.exe" run.mjs --only=wpBookings >> logs\peatix-scheduled.log 2>&1
"C:\Program Files\nodejs\node.exe" run.mjs --only=evemado >> logs\peatix-scheduled.log 2>&1
rem kokuchpro: GitHub Actions (every 30 min) is the usual route, but GitHub IPs are sometimes blocked at the kokuchpro login
rem (all 3 accounts timed out from 2026-11-15). Collect it here too, so it never goes stale.
"C:\Program Files\nodejs\node.exe" run.mjs --only=kokuchpro >> logs\peatix-scheduled.log 2>&1
"C:\Program Files\nodejs\node.exe" run.mjs --only=jimoty >> logs\peatix-scheduled.log 2>&1
rem Katakana names for the dashboard copy button (adds only new names; failures are ignored).
"C:\Program Files\nodejs\node.exe" scripts\build-name-kana.mjs --cap=400 >> logs\peatix-scheduled.log 2>&1
