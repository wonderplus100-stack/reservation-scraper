@echo off
rem Turn the scheduled tasks OFF and stop the update-button receiver (use this on the OLD PC when moving to a new PC, so nothing runs twice).
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach ($n in 'WonderPlus-PeatixScrape','WonderPlus-WhitekeySync','WonderPlus-UpdateWatcher') { if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $n | Out-Null; Write-Host ('Disabled: ' + $n) } }; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'update-watcher' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('Stopped process ' + $_.ProcessId) }"
pause
