import { readFile } from "node:fs/promises";
import { withBrowser } from "../lib/browser.mjs";
import { decodeUtf16Le, findColumn, tableFromCsv } from "../lib/csv.mjs";

// パスワードログインは廃止したため(下記scrapeAccount参照)、認証情報は
// 使わない。EMAILの有無を「このアカウント枠を使う」目印としてのみ使い、
// 実際の認証は保存済みセッション(storage-state、accountLabelでファイルを
// 分ける)頼みになる。
function accountsFromEnv() {
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
  return href || page.url();
}

// ダッシュボード(公開中タブ)に表示されているイベントの一覧を集める。
// 実アカウントで確認したところ「公開中/編集中/終了」はJSタブ切り替えで、
// 同一ページ内にDOMがあるため、ページ内のlist_salesリンクをそのまま拾えばよい。
// 件数が多いアカウント(このアカウントは公開中だけで100件超、終了は1000件超)は
// 無限スクロール/ページネーションで一部しか読み込まれていない可能性があるため、
// 必要に応じてスクロールして追加読み込みさせる処理を足すこと(TODO)。
async function listEvents(page, dashboardUrl) {
  await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  const events = await page.evaluate(() => {
    const results = [];
    for (const link of document.querySelectorAll('a[href*="/list_sales"]')) {
      const idMatch = link.href.match(/\/event\/(\d+)\/list_sales/);
      if (!idMatch) continue;
      let container = link;
      let title = "";
      let applied = 0;
      for (let i = 0; i < 8 && container; i += 1) {
        container = container.parentElement;
        if (!container) break;
        const text = container.textContent || "";
        const countMatch = text.match(/申し込み数[:：]\s*(\d+)/);
        if (countMatch) applied = Number(countMatch[1]);
        const heading = container.querySelector("h1, h2, h3, a[href*='/event/'][href*='/view']");
        if (heading && heading.textContent.trim()) title = heading.textContent.trim();
        if (applied || title) break;
      }
      results.push({ eventId: idMatch[1], title, applied });
    }
    // 重複除去(同じイベントが複数箇所にリンクされている場合がある)
    const byId = new Map(results.map((r) => [r.eventId, r]));
    return Array.from(byId.values());
  });
  console.error(`[peatix診断] dashboardUrl=${dashboardUrl} 実際のURL=${page.url()} イベント件数=${events.length}`);
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
      const attendees = await scrapeEventAttendees(page, event.eventId);
      for (const attendee of attendees) {
        reservations.push({
          rawEventName: event.title || event.eventId,
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
