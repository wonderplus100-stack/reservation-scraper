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


## このPCでの改善を、別のPCにも自動で反映する仕組み

- 改善は、GitHubの `main` に反映されます(このPCで直して、コミットして、プッシュします)。
- 専用PCの自動実行(`scriptsun-peatix-scheduled.cmd` と `scriptsun-whitekey-sync.cmd`)は、実行のたびに最初に `git pull --ff-only` で最新のプログラムを取り込みます。
  - 別のPCは、次の自動実行(最大2時間以内)で、最新になります。
  - 部品が増えたときは、同じタイミングで `npm install` も行います。
  - 手元で変更したファイルがあって取り込めないときは、取り込みを飛ばして、いまのプログラムで続けます。
- ダッシュボードの画面(公開ページ)も、`docs/` をGitHubに反映すると、自動で更新されます。
- 設定ファイル(`.env`)とログイン状態(`browser-profiles`)は、PCごとに別です。GitHubには上がらず、自動では揃いません。

## whitekeyへの自動入力(開始35分前)

- 専用PCのタスク `WonderPlus-WhitekeySync` が、5分おきに動きます(画面は出ません)。
- 開始の35分前〜開始までのパーティーについて、その時点の全予約を、whitekeyの受付登録に入れます。入力済みの予約は、台帳(スプレッドシートの `WhitekeyLedger`)で管理するので、二重に入りません。
- whitekeyにパーティーがない予約は入れず、ダッシュボードの「whitekeyに入っていない予約」に残ります。
- **動かすPCは1台だけにしてください。** `.env` に `WHITEKEY_ENABLED=true` があるPCだけが動きます。別PCに移すときは、元のPCで `WHITEKEY_ENABLED=` を空にしてから、新しいPCで `true` にします。
- 本番に登録するのは、`.env` に `WHITEKEY_COMMIT=true` があるときだけです(空のときは、「入れる予定」を表示するだけです)。

## whitekey(管理システム)への自動入力について

準備中です。ログイン情報の入力と、動作確認(試験用の1件)が済むまで、自動入力は動きません。
