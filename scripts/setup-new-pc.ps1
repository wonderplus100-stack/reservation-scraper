# 新しいPCに、このシステムの「ローカル実行」部分(Peatix・イベマド・ジモティ・公式サイト予約の取得)を
# 取り込むためのセットアップ。PowerShellで、このフォルダの中から実行する:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-new-pc.ps1
# できること: 部品のインストール / 設定ファイル(.env)の雛形作成 / 2時間おきの自動実行の登録。
# パスワード等の秘密情報は扱わない(.env にご自身で入力する)。MIGRATION.md の手順も参照。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== 1/4 Node.js の確認 =="
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js が見つかりません。https://nodejs.org/ から LTS 版をインストールして、もう一度実行してください。"
  exit 1
}
Write-Host ("Node.js: " + (& node --version))

Write-Host "== 2/4 部品のインストール(数分かかります) =="
& npm install
& npx playwright install chromium

Write-Host "== 3/4 設定ファイル(.env) =="
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host ".env を作成しました。メモ帳などで開き、値を入力してください(MIGRATION.md の「設定ファイル」を参照)。"
  Write-Host "  元のPCの .env をコピーするのが最も確実です(USB・パスワード管理ツール等で安全に受け渡してください)。"
} else {
  Write-Host ".env は既にあります(変更しません)。"
}
New-Item -ItemType Directory -Force logs, browser-profiles, storage-state, data | Out-Null

Write-Host "== 4/4 自動実行の登録(2時間おき・画面を出さずに実行) =="
$vbs = Join-Path $root "scripts\run-peatix-scheduled-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('//B //Nologo "' + $vbs + '"')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 2)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 90) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "WonderPlus-PeatixScrape" -Action $action -Trigger $trigger -Settings $settings `
  -Description "Wonder+ 予約の自動取得(Peatix・イベマド・ジモティ・公式サイト予約)" -Force | Out-Null
Write-Host "登録しました: WonderPlus-PeatixScrape"


Write-Host "== whitekey自動入力のタスク(5分おき・既定は無効) =="
$wkVbs = Join-Path $root "scripts\run-whitekey-sync-hidden.vbs"
$wkAction = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('//B //Nologo "' + $wkVbs + '"')
$wkTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5)
$wkSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "WonderPlus-WhitekeySync" -Action $wkAction -Trigger $wkTrigger -Settings $wkSettings `
  -Description "whitekey自動入力(.env の WHITEKEY_ENABLED=true のPCだけ動く。登録は WHITEKEY_COMMIT=true のときだけ)" -Force | Out-Null
Disable-ScheduledTask -TaskName "WonderPlus-WhitekeySync" | Out-Null
Write-Host "登録しました(無効の状態): WonderPlus-WhitekeySync。動かすPCで launcher の 5_Start_AutoRun.cmd を実行すると有効になります。"
Write-Host ""
Write-Host "次の作業(MIGRATION.md の「ログイン」を参照):"
Write-Host "  1. scripts\peatix-relogin.cmd をダブルクリック(Peatixの2アカウント。メールの確認コードが必要)"
Write-Host "  2. scripts\wp-relogin.cmd をダブルクリック(Wonder+公式サイトの管理画面)"
Write-Host "  3. 取得の確認: node run.mjs --only=wpBookings"
Write-Host "  ※ 元のPCの自動実行は、二重に動かないよう停止してください(タスク名 WonderPlus-PeatixScrape を無効化)。"
