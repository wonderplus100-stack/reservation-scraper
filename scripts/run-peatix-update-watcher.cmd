@echo off
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" scripts\peatix-update-watcher.mjs >> logs\peatix-update-watcher.log 2>&1
