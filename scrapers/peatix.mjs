import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { withBrowser, storageStatePath } from "../lib/browser.mjs";
import { decodeUtf16Le, findColumn, tableFromCsv } from "../lib/csv.mjs";

// パスワードログインは廃止したため(下記scrapeAccount参照)、認証情報は
// 使わない。EMAILの有無を「このアカウント枠を使う」目印としてのみ使い、
// 実際の認証は保存済みセッション(storage-state、accountLabelでファイルを
// 分ける)頼みになる。
export function accountsFromEnv() {
  const accounts = [];
  for (const index of [1, 2]) {
    const email = process.env[`PEATIX_${index}_EMAIL`];
    if (!email) continue;
    accounts.push({
      label: process.env[`PEATIX_${index}_ACCOUNT_LABEL`] || `Peatix${index}`
    });
  }
  return accounts;
}

// 実行環境(CI等)でログインフォームが想定通り表示されない場合に、
// 何が起きているか次回ログで分かるようにする診断ヘルパー。
async function logDiagnostics(page, label) {
  try {
    const url = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.error(`[peatix診断:${label}] url=${url}`);
    console.error(`[peatix診断:${label}] bodyText=${JSON.stringify(bodyText)}`);
  } catch (e) {
    console.error(`[peatix診断:${label}] 診断情報の取得にも失敗: ${e.message}`);
  }
}

// ログイン後のダッシュボードURL(https://peatix.com/user/{userId}/dashboard)を
// 取得する(アカウントごとにuserIdが異なるため)。
// 実際に試したところ /user/me/dashboard は直接開くと「ページが
// 見つかりません」表示になり、ログイン済みでも/user/{数字}/dashboardへ
// リダイレクトされないことが分かった(ログイン後のリダイレクト先としてのみ
// 機能する模様)。/signinはログイン済みなら確実に/user/{数字}/dashboardへ
// リダイレクトされる(実アカウントで確認済み)ため、こちらを使う。
async function getDashboardUrl(page) {
  await page.goto("https://peatix.com/signin", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  const href = await page
    .locator('a[href*="/user/"][href*="/dashboard"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  console.error(`[peatix診断] getDashboardUrl: href=${href} page.url=${page.url()}`);
  // 見つかったリンクが「#tickets」付きの場合、それは参加者側の
  // 「マイチケット」画面(開催予定/終了の少数タブ)へのリンクであり、
  // 主催者側の「マイイベント」画面(公開中/編集中/終了、実件数が多い方)
  // とは別物。Browserペインで実アカウントを直接確認したところ、ハッシュを
  // 外した素のdashboard URLに遷移すると正しく「マイイベント」(主催者側)が
  // デフォルト表示されることが分かったため、ハッシュ部分は常に除去する。
  const raw = href || page.url();
  return raw.split("#")[0];
}

// ダッシュボード(公開中タブ)に表示されているイベントの一覧を集める。
// 実アカウントで確認したところ「公開中/編集中/終了」はJSタブ切り替えで、
// 同一ページ内にDOMがあるため、ページ内のlist_salesリンクをそのまま拾えばよい。
// 件数が多いアカウント(このアカウントは公開中だけで100件超、終了は1000件超)は
// 無限スクロール/ページネーションで一部しか読み込まれていない可能性があるため、
// 必要に応じてスクロールして追加読み込みさせる処理を足すこと(TODO)。
// 「終了」タブ等は無限スクロールで追加読み込みされる(1回のクリックでは
// 一部しか読み込まれない。実測: 終了1,174件のアカウントでスクロールなしだと
// 40件しか取れなかった)。list_salesリンクの件数が増えなくなるまで
// 下端へのスクロールを繰り返す。
// ユーザーからの指示: 過去イベントは不要で、当月分だけで良い。イベントは
// 新しい日付順(降順)に並んでいるため、読み込み済みの中の最古の日付が
// 対象月より前になった時点でスクロールを打ち切ることで、Wonder Plusのような
// 終了イベント1,000件超のアカウントでも大量アクセスを避けられる
// (WAF等のアクセス制限に引っかかるリスクを下げる目的)。
async function scrollToLoadAll(page, { maxIterations = 150, stableRounds = 3, waitMs = 600, stopBeforeMonth = null } = {}) {
  let lastCount = -1;
  let stableStreak = 0;
  for (let i = 0; i < maxIterations; i += 1) {
    const count = await page
      .evaluate(() => document.querySelectorAll('a[href*="/list_sales"]').length)
      .catch(() => 0);
    if (count === lastCount) {
      stableStreak += 1;
      if (stableStreak >= stableRounds) break;
    } else {
      stableStreak = 0;
    }
    lastCount = count;

    if (stopBeforeMonth) {
      const oldestKey = await page
        .evaluate(() => {
          let minKey = null;
          for (const link of document.querySelectorAll('a[href*="/list_sales"]')) {
            let el = link;
            for (let i = 0; i < 8 && el; i += 1) {
              el = el.parentElement;
              if (!el) break;
              const m = (el.textContent || "").match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
              if (m) {
                const key = Number(m[1]) * 100 + Number(m[2]);
                if (minKey === null || key < minKey) minKey = key;
                break;
              }
            }
          }
          return minKey;
        })
        .catch(() => null);
      const targetKey = stopBeforeMonth.year * 100 + stopBeforeMonth.month;
      if (oldestKey !== null && oldestKey < targetKey) break;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(waitMs);
  }
  return lastCount;
}

async function collectEventsFromDom(page) {
  return page.evaluate(() => {
    const results = [];
    const samples = [];
    for (const link of document.querySelectorAll('a[href*="/list_sales"]')) {
      const idMatch = link.href.match(/\/event\/(\d+)\/list_sales/);
      if (!idMatch) continue;
      let container = link;
      let title = "";
      let applied = 0;
      let dateYear = null;
      let dateMonth = null;
      let dateDay = null;
      // 以前は「applied か title のどちらか見つかった時点で打ち切り」だったため、
      // 見出し(title)が浅い階層で先に見つかると、より深い階層にしかない
      // 申込み数テキストへ到達する前にループが終わってしまい、applied が
      // 常に0のままになるバグがあった(実際に全イベントでapplied=0を確認)。
      // 両方揃うか8階層登り切るまで探索を続けるように修正。
      for (let i = 0; i < 8 && container; i += 1) {
        container = container.parentElement;
        if (!container) break;
        const text = container.textContent || "";
        const countMatch = text.match(/(?:申し?込み?数|参加(?:者)?数|販売数|チケット数)[:：]?\s*(\d+)/);
        if (countMatch && !applied) applied = Number(countMatch[1]);
        if (dateYear === null) {
          const dateMatch = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
          if (dateMatch) {
            dateYear = Number(dateMatch[1]);
            dateMonth = Number(dateMatch[2]);
            dateDay = Number(dateMatch[3]);
          }
        }
        if (!title) {
          // Browserペインで実DOM構造を確認したところ、イベント名は
          // h3.pod-event-name、日付はtime.event-datetimeという専用クラスを
          // 持っていた。以前はh1〜h3や"/view"リンクを広く拾っていたため、
          // 「参加者」「公開ページ」等の別リンクのテキストを誤って
          // イベント名として使ってしまうバグがあった(全件が実質的に
          // タイトル抽出に失敗し、公式スケジュールとの照合が成立しなかった)。
          const heading = container.querySelector("h3.pod-event-name") || container.querySelector("h1, h2, h3");
          if (heading && heading.textContent.trim()) title = heading.textContent.replace(/\s+/g, " ").trim();
        }
        if (dateYear === null) {
          const timeEl = container.querySelector("time.event-datetime");
          const timeMatch = timeEl && timeEl.textContent.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
          if (timeMatch) {
            dateYear = Number(timeMatch[1]);
            dateMonth = Number(timeMatch[2]);
            dateDay = Number(timeMatch[3]);
          }
        }
        if (applied && title && dateYear !== null) break;
      }
      if (samples.length < 2) {
        samples.push((container ? container.textContent || "" : "").replace(/\s+/g, " ").trim().slice(0, 500));
      }
      results.push({ eventId: idMatch[1], title, applied, dateYear, dateMonth, dateDay });
    }
    // 重複除去(同じイベントが複数箇所にリンクされている場合がある)
    const byId = new Map(results.map((r) => [r.eventId, r]));
    return { events: Array.from(byId.values()), sampleContainerTexts: samples };
  });
}

// 実アカウントのダッシュボードをBrowserペインで直接確認したところ、タブは
// 「公開中|84」「編集中|166」「終了|1,174」の3種類(開催予定/終了、ではない)。
// 初期表示は「公開中」タブのみDOMにあり、他タブはクリックして初めてAjaxで
// 丸ごと読み込まれる(ページネーション/無限スクロールは不要。クリック後は
// 該当タブの全件が一度にDOMへ挿入されることを実測で確認: 終了1,174件クリック後
// document.querySelectorAll('a[href*="list_sales"]').length が公開中+終了の
// 合計とほぼ一致した)。編集中(下書き)には参加者がいないため対象外とする。
// 「終了」タブのリンクは href="javascript:void(0);" かつ表示名が
// 「終了 | 1,174」の形式。ページ内には「受付終了」(個別イベントの状態表示)や
// href="#finished" の別リンクも「終了」を含むテキストとして存在し、単純な
// 完全一致(exact:"終了")だとそちらを誤クリックしてしまうバグがあったため、
// 「終了 | 数字」の形に一致するものだけを狙う。
async function listEvents(page, dashboardUrl) {
  await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  // dashboard(SPA)は「グループ」(主催者イベント一覧)と「チケット」(参加者
  // 側のマイチケット)の2大タブを持ち、直接同じURLへ遷移しても、ブラウザの
  // localStorage等に残った直前の選択タブの状態次第で「チケット」側が
  // デフォルト表示されてしまうケースを実機で確認した(公開中/編集中/終了の
  // 主催者イベント一覧ではなく、開催予定/終了の参加者チケット一覧が出てしまう)。
  // 確実に主催者イベント一覧を表示させるため、明示的に「グループ」タブを
  // クリックする。
  const groupTab = page.getByRole("link", { name: "グループ", exact: true }).or(page.getByRole("button", { name: "グループ", exact: true }));
  const groupTabCount = await groupTab.count().catch(() => 0);
  if (groupTabCount > 0) {
    await groupTab.first().click().catch((e) => console.error(`[peatix診断] グループタブのクリックに失敗: ${e.message}`));
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);
  } else {
    console.error("[peatix診断] グループタブが見つかりませんでした");
  }

  const allEvents = new Map();
  let lastSamples = [];

  // ユーザー指示により、過去イベントは不要で当月分のみ対象とする。
  const now = new Date();
  const targetMonth = { year: now.getFullYear(), month: now.getMonth() + 1 };

  await scrollToLoadAll(page, { stopBeforeMonth: targetMonth });
  const { events: publishedEvents, sampleContainerTexts: publishedSamples } = await collectEventsFromDom(page);
  for (const ev of publishedEvents) allEvents.set(ev.eventId, ev);
  lastSamples = publishedSamples;
  console.error(`[peatix診断] 公開中タブ イベント件数=${publishedEvents.length}`);

  const endedTab = page.getByRole("link", { name: /^終了\s*\|/ });
  const endedTabCount = await endedTab.count().catch(() => 0);
  if (endedTabCount > 0) {
    await endedTab.first().click().catch((e) => console.error(`[peatix診断] 終了タブのクリックに失敗: ${e.message}`));
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2000);
    await scrollToLoadAll(page, { stopBeforeMonth: targetMonth });
    const { events: endedEvents, sampleContainerTexts: endedSamples } = await collectEventsFromDom(page);
    for (const ev of endedEvents) allEvents.set(ev.eventId, ev);
    lastSamples = endedSamples;
    console.error(`[peatix診断] 終了タブ イベント件数=${endedEvents.length}`);
  } else {
    console.error("[peatix診断] 終了タブが見つかりませんでした");
  }

  const targetKey = targetMonth.year * 100 + targetMonth.month;
  const beforeFilterCount = allEvents.size;
  const events = Array.from(allEvents.values()).filter(
    (e) => e.dateYear !== null && e.dateYear * 100 + e.dateMonth === targetKey
  );
  console.error(
    `[peatix診断] 当月(${targetMonth.year}年${targetMonth.month}月)絞り込み: ${beforeFilterCount}件 → ${events.length}件`
  );
  console.error(`[peatix診断] dashboardUrl=${dashboardUrl} 実際のURL=${page.url()} 合計イベント件数=${events.length}`);
  const appliedZeroCount = events.filter((e) => !e.applied).length;
  if (appliedZeroCount > 0) {
    console.error(`[peatix診断] applied=0のイベント数=${appliedZeroCount}/${events.length}`);
    lastSamples.forEach((t, i) => console.error(`[peatix診断] サンプルコンテナtext[${i}]=${JSON.stringify(t)}`));
  }
  if (events.length === 0) {
    await logDiagnostics(page, "ダッシュボードでイベントが0件");
  }
  return events;
}

// 参加者一覧ページで氏名を取得する。まずCSVダウンロードを試み、
// 取得できなければ画面上の表示から拾う(フォールバック)。
// 注意: 実アカウントで確認したところ、まとめ買いされたチケットは
// 購入者名がグループ表示され個々の参加者名までは判別できないケースがある
// (例:「ワンダー プラス 10 x 男性チケット」のような表示)。
// これは決済時に個別の参加者名を収集していないイベントである可能性が高く、
// 氏名ベースの正確なユニーク集計ができない場合がある点に注意。
async function scrapeEventAttendees(page, eventId) {
  // 実アカウントのスクリーンショットで確認したところ、管理画面の
  // 「注文/参加者一覧」リンクは /list_attendees ではなく /list_sales を
  // 指していた(list_attendeesは存在しない/別物のURLだった可能性が高く、
  // これが集客0件の原因と考えられる)。
  await page.goto(`https://peatix.com/event/${eventId}/list_sales`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  const csvLink = page.getByText("参加者リスト(CSV)", { exact: false });
  const csvLinkCount = await csvLink.count();
  if (csvLinkCount === 0) {
    await logDiagnostics(page, `list_salesにCSVリンクが見つからない(eventId=${eventId})`);
  }
  if (csvLinkCount > 0) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 5000 }),
        csvLink.first().click()
      ]);
      const path = await download.path();
      if (path) {
        const fileBuffer = await readFile(path);
        // 実アカウントで確認済み: Content-Type: text/csv; charset=UTF-16LE、
        // タブ区切り。以前はShift JIS・カンマ区切りと誤って想定しており、
        // これが名前抽出が常に0件になっていた実際の原因だった。
        // 列は「名前」(カタカナ読み)と「表示名」(本人が入力した表示名、
        // 漢字/ニックネーム/英字など)に分かれている。
        const text = decodeUtf16Le(fileBuffer);
        const rows = tableFromCsv(text, "\t");
        const headers = rows[0] ? Object.keys(rows[0]) : [];
        const displayNameColumn = findColumn(headers, ["表示名"]) || findColumn(headers, ["氏名", "お名前", "名前", "Name"]);
        const katakanaColumn = findColumn(headers, ["名前"]);
        if (displayNameColumn) {
          return rows
            .map((row) => ({
              name: String(row[displayNameColumn] || "").trim(),
              readingKatakana: katakanaColumn ? String(row[katakanaColumn] || "").trim() : ""
            }))
            .filter((r) => r.name);
        }
      }
    } catch {
      // ダウンロードが発生しなかった場合は画面表示のフォールバックへ。
    }
  }

  // フォールバック: 画面上に表示されている購入者名を拾う。
  // TODO(要確認): 個々の参加者行の正確なセレクタ。ここでは大まかな推定。
  const fallbackNames = await page.evaluate(() => {
    const names = [];
    for (const el of document.querySelectorAll("li, tr")) {
      const text = (el.textContent || "").trim();
      const match = text.match(/^([^\d]{2,20}?)\s*\d+\s*x\s*/);
      if (match) names.push(match[1].trim());
    }
    return names;
  });
  return fallbackNames.map((name) => ({ name, readingKatakana: "" }));
}

// "/user/{数字}/dashboard"の形なら本物のログイン後ダッシュボード、
// それ以外(未ログイン時に飛ばされる公開ページ等)は未ログインとみなす。
function isAuthenticatedDashboardUrl(url) {
  return /\/user\/\d+\/dashboard/.test(String(url || ""));
}

// ダッシュボードの「今すぐ更新」ボタンからの遠隔トリガー向け。
// 保存済みセッションが有効ならブラウザを一瞬開いてCookieを更新するだけで
// すぐ戻る。無効な場合は画面付き(headed)ブラウザを開いたまま待機し、
// 手元でメール確認コードを使ってログインが完了するのを検知する。
// 注意: manual-login.mjsと違いEnterキー入力を待たない。ログイン中の
// フォーム操作を妨げないよう、ページの再読み込みは行わずpage.url()の
// 変化だけを受動的に監視する。
export async function ensureLoggedIn(accountLabel, { onStatus, timeoutMs = 15 * 60 * 1000 } = {}) {
  const statePath = storageStatePath(`peatix-${accountLabel}`);
  const hasSavedState = fs.existsSync(statePath);
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext(
      hasSavedState ? { storageState: statePath, locale: "ja-JP" } : { locale: "ja-JP" }
    );
    const page = await context.newPage();
    const dashboardUrl = await getDashboardUrl(page);
    if (isAuthenticatedDashboardUrl(dashboardUrl)) {
      // まだ有効でも、Cloudflareのボット対策Cookie(__cf_bm)は寿命が短いため
      // 開いたついでに保存し直しておく(headedで開くだけで更新される)。
      await context.storageState({ path: statePath });
      return { loggedIn: true, wasAlreadyValid: true };
    }
    onStatus?.(`「${accountLabel}」アカウントの認証コードをGmailで確認し、開いたブラウザ画面でログインしてください`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      if (isAuthenticatedDashboardUrl(page.url())) {
        await context.storageState({ path: statePath });
        return { loggedIn: true, wasAlreadyValid: false };
      }
    }
    return { loggedIn: false, wasAlreadyValid: false, timedOut: true };
  } finally {
    await browser.close();
  }
}

async function scrapeAccount(account) {
  return withBrowser(`peatix-${account.label}`, async (page, { hasSavedState }) => {
    // ユーザーからの確認事項: Peatixはパスワードだけでのログインを常に
    // 受け付けず、メール確認(ワンタイムコード)を都度要求する仕様であり、
    // 自動化では突破できない。そのため、保存済みセッションが有効な間は
    // それを使い回し、無効になった(=誰かが手動でメールコードを使って
    // 再ログインし、そのセッションが更新されるまで待つ必要がある)場合は
    // 無駄なパスワードログインを試みず、はっきり分かるログを出して
    // 即座にあきらめる(通知目的)。
    const dashboardUrl = hasSavedState ? await getDashboardUrl(page) : null;
    if (!isAuthenticatedDashboardUrl(dashboardUrl)) {
      throw new Error(
        `Peatix(${account.label}): 保存済みセッションが無効です。手動でメール確認コードを使って再ログインしてください(パスワードのみでの自動ログインはPeatixの仕様上できません)。`
      );
    }
    const events = await listEvents(page, dashboardUrl);

    const reservations = [];
    for (const event of events) {
      if (!event.applied) continue; // 申込み0件のイベントはスキップ
      // WAF等のアクセス制限を刺激しないよう、イベントページ間に短い間隔を空ける。
      await page.waitForTimeout(400);
      const attendees = await scrapeEventAttendees(page, event.eventId);
      // 公式スケジュール(matchOfficialEvent)は日付+会場をrawEventNameの
      // テキストから抽出するため、Peatixのイベントタイトル自体には日付が
      // 含まれない(ダッシュボード上は別欄表示)点を補って埋め込む。
      // これが無いと、こくちーずPROの旧不具合と同様に常に「未マッピング」に
      // なってしまう。
      const dateSuffix = event.dateMonth && event.dateDay ? `｜${event.dateMonth}月${event.dateDay}日` : "";
      const rawEventName = `${event.title || event.eventId}${dateSuffix}`;
      for (const attendee of attendees) {
        reservations.push({
          rawEventName,
          reservationName: attendee.name,
          readingKatakana: attendee.readingKatakana
        });
      }
    }
    return reservations;
  });
}

export async function collect() {
  const accounts = accountsFromEnv();
  const obtainedAt = new Date().toISOString();
  const rows = [];

  for (const account of accounts) {
    // 複数アカウント(Wonder+/Jua Party等)を扱うため、1アカウントの
    // セッション切れ等の失敗が他アカウントの取得まで止めないようにする。
    let reservations = [];
    try {
      reservations = await scrapeAccount(account);
    } catch (err) {
      console.error(`peatix(${account.label}) の取得に失敗しました:`, err.message);
      continue;
    }
    for (const reservation of reservations) {
      rows.push({
        platform: "peatix",
        account: account.label,
        rawEventName: reservation.rawEventName,
        reservationName: reservation.reservationName,
        readingKatakana: reservation.readingKatakana || "",
        obtainedAt
      });
    }
  }
  return rows;
}
