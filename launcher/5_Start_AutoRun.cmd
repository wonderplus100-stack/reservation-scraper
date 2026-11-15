@echo off
rem STEP 5: turn the scheduled tasks ON.
rem  - WonderPlus-PeatixScrape: data collection every 2 hours.
rem  - WonderPlus-UpdateWatcher: receives the dashboard "update" button (run it on ONE PC only) and starts now.
rem  - WonderPlus-WhitekeySync: only when .env has WHITEKEY_ENABLED=true (ONE PC only). Real entry into whitekey happens only when .env has WHITEKEY_COMMIT=true.
call "%~dp0_common.cmd"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Enable-ScheduledTask -TaskName 'WonderPlus-PeatixScrape' | Out-Null; Write-Host 'Enabled: WonderPlus-PeatixScrape (data collection, every 2 hours)'; if (Get-ScheduledTask -TaskName 'WonderPlus-UpdateWatcher' -ErrorAction SilentlyContinue) { Enable-ScheduledTask -TaskName 'WonderPlus-UpdateWatcher' | Out-Null; Start-ScheduledTask -TaskName 'WonderPlus-UpdateWatcher'; Write-Host 'Enabled and started: WonderPlus-UpdateWatcher (dashboard update button receiver)' } else { Write-Host 'Missing: WonderPlus-UpdateWatcher (run 1_Setup.cmd again)' }; $e = Select-String -Path '%REPO%\.env' -Pattern '^WHITEKEY_ENABLED=true' -Quiet; if ($e -and (Get-ScheduledTask -TaskName 'WonderPlus-WhitekeySync' -ErrorAction SilentlyContinue)) { Enable-ScheduledTask -TaskName 'WonderPlus-WhitekeySync' | Out-Null; Write-Host 'Enabled: WonderPlus-WhitekeySync (whitekey entry, every 5 minutes)' } else { Write-Host 'Skipped: WonderPlus-WhitekeySync (WHITEKEY_ENABLED is not true on this PC)' }"
pause
