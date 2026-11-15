# ダッシュボードの「データを更新」ボタンの受け口(update-watcher)を、PCにログオンした時に自動で起動するよう登録する。
# 使い方(このフォルダで): powershell -ExecutionPolicy Bypass -File scripts\install-update-watcher.ps1
$ErrorActionPreference = "Stop"
$vbs = Join-Path $PSScriptRoot "run-update-watcher-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName "WonderPlus-UpdateWatcher" -Action $action -Trigger $trigger -Settings $settings -Description "Wonder+ dashboard update button receiver" -Force | Out-Null
Start-ScheduledTask -TaskName "WonderPlus-UpdateWatcher"
Write-Host "登録して起動しました(WonderPlus-UpdateWatcher)。PCにログオンするたびに自動で起動します。"
