# wonder-plus-reservation-scraper

こくちーずPRO / Peatix / つなげーと / Googleフォーム、計7アカウントの予約状況を
自動収集し、プライベートなGoogleスプレッドシートに集計するバッチです。
集計結果は別リポジトリ `wonder-plus-reservation-dashboard`(Google Apps Script)
のダッシュボードから確認します。

## 前提・注意事項

- こくちーずPRO/Peatix/つなげーとの自動ログインは、各サービスの利用規約に
  抵触する可能性があります。アカウント停止等のリスクを理解した上で運用してください。
- ID/パスワード/2段階認証シークレットは、このリポジトリにもチャットにも
  絶対に書き込まないでください。GitHub Actions の Secrets にのみ登録します。
- こくちーずPROは現時点で `wonderplus100@gmail.com` のアカウントのみ対象です。
  もう一方のアカウントは、動作確認が済むまで `.env` / Secrets に値を入れないでください。

## セットアップ手順

### 1. データ保存用スプレッドシートを作成する

1. 新しいGoogleスプレッドシートを作成し、**共有は非公開のまま**にする(リンク共有しない)。
2. 以下のシート(タブ)を作成する:
   - `RawData` — 1行目に見出し: `platform,account,rawEventName,canonicalEventId,reservationName,normalizedName,obtainedAt`
   - `EventMaster` — 1行目に見出し: `canonicalEventId,canonicalEventName,platform,account,rawEventName`
     (媒体ごとに表記が違うイベント名を、共通のイベントIDに手動で紐付けるための表)
   - `Summary` — スクリプトが自動生成するので空のままでよい
   - `Unmapped` — 1行目に見出し: `platform,account,rawEventName,obtainedAt`
     (EventMasterに未登録のイベント名が出た場合にここに溜まる。定期的に確認しEventMasterへ追記する)
3. スプレッドシートのURLからIDを控える(`.../d/【ここ】/edit`の部分) → `SHEET_ID`

### 2. Googleサービスアカウントを作成する(無料)

1. Google Cloud Consoleでプロジェクトを作成(既存プロジェクトの流用でも可)。
2. 「APIとサービス」で **Google Sheets API** を有効化する。
3. 「認証情報」からサービスアカウントを新規作成し、JSON形式の鍵を1つ発行してダウンロードする。
4. 手順1のスプレッドシートを開き、共有設定でサービスアカウントのメールアドレス
   (`xxxx@xxxx.iam.gserviceaccount.com`)を「編集者」として追加する。
5. Googleフォームの回答スプレッドシートについても、同じサービスアカウントを
   「閲覧者」として共有する(FORM_1 / FORM_2 それぞれ)。

### 3. GitHub Secretsに登録する

`.env.example` を参照し、対応するリポジトリ Secrets(Settings > Secrets and
variables > Actions)に同名で登録する。特に:

- `SHEET_ID`: 手順1のスプレッドシートID
- `GOOGLE_SERVICE_ACCOUNT_JSON`: 手順2でダウンロードしたJSONファイルの中身をそのまま1行の文字列として登録
- `KOKUCHPRO_1_*`: `wonderplus100@gmail.com` のみ登録(他は空のまま)

### 4. 2段階認証(TOTP)シークレットの取得方法

対象アカウントで2段階認証を「認証アプリ」方式に設定する際、QRコードと一緒に
「テキストで表示」「セットアップキーを表示」のようなリンクがあれば、そこに
32文字程度の英数字(Base32形式)が表示されます。これが `*_TOTP_SECRET` の値です。
QRコードしか表示されない場合は、QR画像に埋め込まれたURL内の `secret=` パラメータ
から取得できます(ブラウザの開発者ツールでQR画像のalt属性やリンク先を確認)。
SMS方式の2段階認証は自動化できないため、対象アカウントは認証アプリ方式へ
切り替えることを推奨します。

### 5. ローカルで動作確認する

```bash
cd wonder-plus-reservation-scraper
npm install
npx playwright install chromium
cp .env.example .env   # .envに実際の値を入力する
npm run scrape:forms   # まずGoogleフォームのみ(ログイン不要)で確認
```

こくちーずPRO/Peatix/つなげーとのスクレイパーは `scrapers/*.mjs` 内に
`TODO(要確認)` として未実装/要調整の箇所を明記しています。ログイン後の
画面構造は実際のアカウントでログインしないと分からないため、下記のコマンドで
Playwrightのコード生成ツールを使い、実際にクリックした操作からセレクタを
確認・転記してください(ブラウザが開き、操作を記録できます)。

```bash
npm run codegen:kokuchpro
npm run codegen:peatix
npm run codegen:tunagate
```

`HEADLESS=false` を `.env` に設定すると、ブラウザ画面を表示しながら
`npm run scrape:kokuchpro` 等を実行でき、動作確認がしやすくなります。

### 6. GitHub Actionsを有効化する

Secrets登録後、Actionsタブから `scrape-reservations` を **workflow_dispatch(手動実行)**
でまず実行し、ログにエラーが出ないことを確認してください。問題なければ
`schedule` による30分おきの自動実行がそのまま有効になります。

## 実装状況(フェーズ)

- [x] Phase 1: Googleフォーム(×2)取り込み、シート/EventMaster設計 — 実装済み。
      実際の回答スプレッドシートを確認したところ、FORM_1は関東/中部/関西/
      東北信越/中国四国/九州ごとに「ご参加希望日◯◯」という列が分かれており、
      かつフォーム改修の履歴で同じ質問(氏名など)の列が複数回登場する
      構造だったため、列名の完全一致ではなく部分一致(`*_NAME_COLUMN_PATTERN`
      / `*_EVENT_COLUMN_PATTERN`)で該当列を拾う実装に変更した。氏名列の
      判定では「フリガナ」列を誤って拾わないよう除外している。
      FORM_2はシンプルな単一列構成(お名前/参加希望日時)。
      スプレッドシート本体(RawData/EventMaster/Summary/Unmapped)は
      ユーザー側で作成済み・ヘッダーも確認済み。
- [x] Phase 2: こくちーずPRO(wonderplus100@gmail.comのみ) — 実アカウントで画面遷移を
      確認済み。ログイン→登録イベント一覧(募集中/終了)→各イベントの開催日一覧→
      参加者管理ページ→「参加者名簿のダウンロード」ボタンでCSV取得、まで実装。
      現時点でこのアカウントは申込み0件のため、**CSVの実際の列名(氏名列の見出し)は
      未検証**。`scrapers/kokuchpro.mjs`は「氏名」「お名前」「名前」のいずれかを
      含む列を氏名として自動判定するようにしてあるが、初めて申込みが入った際に
      `node run.mjs --only=kokuchpro`を実行し、コンソールに列名の警告が出ないか
      確認すること。ログインフォームの送信は「パスワード欄でEnter」方式にしており、
      送信ボタンの厳密なセレクタには依存していない。
- [x] Phase 3: Peatix(実アカウント「Wonder Plus」で画面遷移を確認済み) —
      ログイン→ダッシュボード(`/user/{userId}/dashboard`、userIdは動的取得)→
      各イベントの`/event/{id}/list_attendees`→「参加者リスト(CSV)」ボタン、
      まで実装。ボタンのクリックからダウンロードイベントが発火しなかった場合の
      フォールバック(画面表示からの抽出)も用意している。
      **重要な制約**: このアカウントで確認した限り、まとめ買いされたチケットは
      購入者名がグループ表示され(例:「ワンダー プラス 10 x 男性チケット」)、
      個々の参加者の氏名までは判別できないイベントがある(決済時に参加者ごとの
      氏名を収集していないため)。この場合、氏名ベースの正確なユニーク集計が
      できない可能性がある点に注意。CSVダウンロード側でより詳細な情報が
      得られるかは未検証(エンコードもShift JISと仮定しているが未検証)。
- [x] Phase 4: つなげーと(実アカウントで画面遷移を確認済み) —
      ログイン→`/mypage/management`で管理サークル一覧取得→
      `/circle/{id}/events`でイベント一覧取得→`/event/{id}/participants`で
      参加者取得、まで実装。参加者データはページのReactコンポーネントに
      埋め込まれたJSON(`data-react-props`)から取得しており、画面デザイン
      変更に強い実装になっている。
      **重要な制約**: つなげーとは参加者が「本名非公開」設定にしている場合、
      氏名の代わりに`@ハンドル名`しか取得できないプラットフォーム仕様。
      この場合、こくちーずPRO/Peatix/Googleフォームの本名とは名寄せできない。
      本名を公開している参加者のみ、実名ベースの名寄せが可能。
      なお、つなげーとには「外部API(`/user_api_tokens`)」が用意されているが、
      これはイベントの作成・公開・編集専用のAPIで、参加者情報の取得はできない
      (ドキュメント: `/support/external_api`で確認済み)。
- [ ] Phase 5: 2FA本実装の検証、セッション永続化の安定化、こくちーずPRO2アカウント目、
      Peatix/つなげーとのCSVダウンロード実データでの検証、大量イベントがある
      アカウント(Peatixは終了イベントだけで1,000件超)のページネーション対応

## 次に人の手で必要な作業

Google側は完了済み(スプレッドシート・シートタブ・サービスアカウント・
Sheets API有効化・JSON鍵発行まですべて確認済み)。残っているのは:

- GitHubリポジトリを作成し、Settings > Secrets and variables > Actionsに
  以下を登録する:
  - `SHEET_ID` = `1rGKzM9Ffvc5uMkr0i3O7MxqSzYbSUPZCc_nv7OV9KfM`
  - `GOOGLE_SERVICE_ACCOUNT_JSON` = 発行済みのJSON鍵の中身(ダウンロードした
    ファイルをそのまま1行のJSON文字列として貼り付け)
  - `FORM_1_SPREADSHEET_ID` = `1a9NXZHUCWjIB0lt0LgT179hg32JtNa-nIQIOj6uSQG0`
  - `FORM_2_SPREADSHEET_ID` = `10UPhQLOSv0xzF5Jl422wb9sy2GAHXTtf2JDEiNs1kuE`
  - (FORM_1/2の`SHEET_NAME`/`NAME_COLUMN_PATTERN`/`EVENT_COLUMN_PATTERN`は
    `.env.example`の初期値のままでよいことを実データで確認済み)
  - こくちーずPRO(`wonderplus100@gmail.com`)/Peatix/つなげーとのID・パスワード
  - リポジトリの公開/非公開は社内ツールのため非公開を推奨(認証情報はコードに
    含まれないため公開でも秘密情報が漏れることはない)
- ローカルでの動作確認: `.env`は同梱のもの(SHEET_ID/FORM系IDは記入済み)を
  ベースに、`GOOGLE_SERVICE_ACCOUNT_JSON`とこくちーずPRO/Peatix/つなげーとの
  パスワードを追記して`npm run scrape:forms`から試すのがおすすめ
- Peatix/つなげーとでCSVダウンロード実行時の実際の列名を、初回の実データで確認する
  (つなげーとはCSVを使わずReactの構造化データから直接取得するため対象外)
