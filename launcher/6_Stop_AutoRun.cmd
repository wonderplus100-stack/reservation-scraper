@echo off
rem Turn the scheduled tasks OFF (use this on the OLD PC when moving to a new PC, so nothing runs twice).
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach ($n in 'WonderPlus-PeatixScrape','WonderPlus-WhitekeySync') { if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $n | Out-Null; Write-Host ('Disabled: ' + $n) } }"
pause
