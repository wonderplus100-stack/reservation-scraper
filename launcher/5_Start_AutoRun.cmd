@echo off
rem STEP 5: turn the scheduled tasks ON. The whitekey entry task is enabled only when .env has WHITEKEY_ENABLED=true
rem (use it on ONE PC only). Real entry into whitekey happens only when .env has WHITEKEY_COMMIT=true.
call "%~dp0_common.cmd"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Enable-ScheduledTask -TaskName 'WonderPlus-PeatixScrape' | Out-Null; Write-Host 'Enabled: WonderPlus-PeatixScrape (data collection, every 2 hours)'; $e = Select-String -Path '%REPO%\.env' -Pattern '^WHITEKEY_ENABLED=true' -Quiet; if ($e -and (Get-ScheduledTask -TaskName 'WonderPlus-WhitekeySync' -ErrorAction SilentlyContinue)) { Enable-ScheduledTask -TaskName 'WonderPlus-WhitekeySync' | Out-Null; Write-Host 'Enabled: WonderPlus-WhitekeySync (whitekey entry, every 5 minutes)' } else { Write-Host 'Skipped: WonderPlus-WhitekeySync (WHITEKEY_ENABLED is not true on this PC)' }"
pause
