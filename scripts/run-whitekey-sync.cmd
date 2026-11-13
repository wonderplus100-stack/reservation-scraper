@echo off
rem whitekey auto entry: runs every 5 minutes. Only acts for parties that start within 35 minutes,
rem and only on the one PC that has WHITEKEY_ENABLED=true in .env (other PCs do nothing).
cd /d "%~dp0.."
if not exist logs mkdir logs
rem Same latest-code rule as the other scheduled run (fast-forward only, failures ignored).
git pull --ff-only --quiet >> logs\whitekey-sync.log 2>&1
"C:\Program Files\nodejs\node.exe" scripts\whitekey-sync.mjs >> logs\whitekey-sync.log 2>&1
