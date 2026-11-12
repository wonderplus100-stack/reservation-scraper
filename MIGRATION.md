# 別のPCへの移植手順

このシステムは、次の3つで動いています。

| 部分 | 場所 | 移植が必要か |
|---|---|---|
| ダッシュボードの画面 | GitHub Pages(誰でも開ける公開ページ)と Google Apps Script | **不要**(クラウドで動いています。どのPCからも開けます) |
| こくちーず・Googleフォームの取得 | GitHub Actions(30分おき) | **不要**(クラウドで動いています) |
| Peatix・イベマド・ジモティ・公式サイト予約の取得 | **専用PCのタスクスケジューラ(2時間おき)** | **必要**(この手順の対象) |

専用PCで動かす理由: Peatix・公式サイトの管理画面はログインが必要で、イベマドとジモティはGitHubのIPからは取得できないためです。

## 共有URL

- **ダッシュボード(誰でも開ける)**: 共有URLをお渡しします(下記の鍵つきURL)。通常のブラウザで開けます。
- **このシステムの一式(移植元)**: https://github.com/wonderplus100-stack/reservation-scraper

> 氏名を含むため、ダッシュボードは「鍵つきURL」を知っている人だけが見られます。鍵は共有URLの `#k=` 以降です。
> 鍵を変えたいときは、スプレッドシートの「Config」シート(A列 `dashboardKey` の隣のB列)を書き換えます。

## 新しいPCでの手順

1. **Node.js(LTS)** と **Git** をインストールします。Google Chrome も入れておいてください。
2. 次を実行して、一式を取得します(PowerShell)。
   ```
   cd $HOME\Downloads
   git clone https://github.com/wonderplus100-stack/reservation-scraper.git wonder-plus-reservation-scraper
   cd wonder-plus-reservation-scraper
   powershell -ExecutionPolicy Bypass -File scripts\setup-new-pc.ps1
   ```
   部品のインストール、`.env` の雛形作成、2時間おきの自動実行の登録まで行います。
3. **設定ファイル(`.env`)** を入力します。元のPCの `.env` をコピーするのが最も確実です(USBメモリやパスワード管理ツールなどで安全に受け渡してください。メールやチャットには貼らないでください)。主な項目:
   - `SHEET_ID` / `GOOGLE_SERVICE_ACCOUNT_JSON`: 集計用スプレッドシートと、そこへ書き込むサービスアカウントの鍵
   - `PEATIX_1_*` / `PEATIX_2_*`: Peatixの2アカウント(ラベルは `Wonder Plus` と `Jua Party`)
   - `WP_BOOKINGS_ENABLED=true`: 公式サイトの予約を取得する
   - `JIMOTY_1_*`: ジモティ
   - `HEADLESS=true`: 画面を出さずに実行する
4. **ログイン**(PCごとに1回。パスワードやメールの確認コードは、ご自身で入力します):
   - `scripts\peatix-relogin.cmd` をダブルクリック。Peatixの2アカウントを順にログインします。**ログインしたアカウントの名前が、表示された名前(Wonder Plus / Jua Party)と一致していることを確認してください。**
   - `scripts\wp-relogin.cmd` をダブルクリック。Wonder+公式サイトの管理画面にログインします(「ログイン状態を保存する」にチェックすると約2週間もちます)。
5. **動作確認**: 次を実行し、エラーなく件数が出ることを確認します。
   ```
   node run.mjs --only=peatix
   node run.mjs --only=wpBookings
   ```
   ダッシュボードの「データの取得状況」に、各取得先の最終取得時刻が出ます。
6. **元のPCの自動実行を止めます**(二重に動かないため)。タスクスケジューラで `WonderPlus-PeatixScrape` を無効にします。

## 日常の運用

- ログインが切れると、ダッシュボードの「データの取得状況」に警告が出ます。上のログイン用のcmdをダブルクリックしてください。
- GitHub側(こくちーず・Googleフォーム)の設定は、GitHubの Settings → Secrets and variables にあります。PCを変えても影響しません。

## whitekey(管理システム)への自動入力について

準備中です。ログイン情報の入力と、動作確認(試験用の1件)が済むまで、自動入力は動きません。
