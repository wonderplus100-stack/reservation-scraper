import { readFile } from "node:fs/promises";
import { submitForm, withBrowser } from "../lib/browser.mjs";
import { generateTotpCode } from "../lib/totp.mjs";
import { decodeShiftJis, findColumn, tableFromCsv } from "../lib/csv.mjs";

const LOGIN_URL = "https://peatix.com/signin";

function accountsFromEnv() {
  const accounts = [];
  for (const index of [1, 2]) {
    const email = process.env[`PEATIX_${index}_EMAIL`];
    const password = process.env[`PEATIX_${index}_PASSWORD`];
    if (!email || !password) continue;
    accounts.push({
      label: process.env[`PEATIX_${index}_ACCOUNT_LABEL`] || `Peatix${index}`,
      email,
      password,
      totpSecret: process.env[`PEATIX_${index}_TOTP_SECRET`] || ""
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

// Peatixのログインは「Sign in with emailをクリック→メール入力→Next→パスワード入力」の
// 3段階(SPA)。以前はランディング画面が出ずメール欄がいきなり表示されていたが、
// CI環境での診断ログにより、まず選択画面(Google/Appleでサインイン or
// Sign in with email)が表示され、"Sign in with email"をクリックしないと
// メール入力欄が現れないことが判明した。
async function login(page, account) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // domcontentloaded直後はReactの描画前で要素がまだ存在しないため、
  // count()での即時チェックではなく、出現を待ってからクリックする
  // (出なければ元々メール欄がある旧UIとみなしてスキップする)。
  try {
    await page
      .getByText(/sign in with email|メールで(サインイン|ログイン)/i)
      .first()
      .click({ timeout: 15000 });
  } catch {
    // 選択画面が出ない場合は何もしない(メール欄が直接表示されているはず)。
  }

  try {
    await page.getByPlaceholder(/メール|email/i).fill(account.email, { timeout: 20000 });
  } catch (err) {
    await logDiagnostics(page, "メール入力欄が見つからない");
    throw err;
  }
  await page.getByRole("button", { name: /Next|次へ/i }).click();

  const passwordInput = page.locator('input[type="password"]');
  await passwordInput.waitFor({ state: "visible", timeout: 15000 });
  await passwordInput.fill(account.password);
  await submitForm(page, passwordInput);

  if (account.totpSecret) {
    // TODO(要確認): Peatixの2段階認証コード入力欄のセレクタ。
    const totpInput = page.locator('input[name="otp"], input[name="code"], input[autocomplete="one-time-code"]');
    if ((await totpInput.count()) > 0) {
      await totpInput.first().fill(generateTotpCode(account.totpSecret));
      await page.keyboard.press("Enter");
      await page.waitForLoadState("networkidle").catch(() => {});
    }
  }
}

// ログイン後のダッシュボードURL(https://peatix.com/user/{userId}/dashboard)を
// ページ内リンクから動的に取得する(アカウントごとにuserIdが異なるため)。
async function getDashboardUrl(page) {
  await page.goto("https://peatix.com/user/me/dashboard").catch(() => {});
  const href = await page
    .locator('a[href*="/user/"][href*="/dashboard"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  return href || page.url();
}

// ダッシュボード(公開中タブ)に表示されているイベントの一覧を集める。
// 実アカウントで確認したところ「公開中/編集中/終了」はJSタブ切り替えで、
// 同一ページ内にDOMがあるため、ページ内のlist_salesリンクをそのまま拾えばよい。
// 件数が多いアカウント(このアカウントは公開中だけで100件超、終了は1000件超)は
// 無限スクロール/ページネーションで一部しか読み込まれていない可能性があるため、
// 必要に応じてスクロールして追加読み込みさせる処理を足すこと(TODO)。
async function listEvents(page, dashboardUrl) {
  await page.goto(dashboardUrl);
  await page.waitForLoadState("networkidle").catch(() => {});

  return page.evaluate(() => {
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
}

// 参加者一覧ページで氏名を取得する。まずCSVダウンロードを試み、
// 取得できなければ画面上の表示から拾う(フォールバック)。
// 注意: 実アカウントで確認したところ、まとめ買いされたチケットは
// 購入者名がグループ表示され個々の参加者名までは判別できないケースがある
// (例:「ワンダー プラス 10 x 男性チケット」のような表示)。
// これは決済時に個別の参加者名を収集していないイベントである可能性が高く、
// 氏名ベースの正確なユニーク集計ができない場合がある点に注意。
async function scrapeEventAttendees(page, eventId) {
  await page.goto(`https://peatix.com/event/${eventId}/list_attendees`);
  await page.waitForLoadState("networkidle").catch(() => {});

  const csvLink = page.getByText("参加者リスト(CSV)", { exact: false });
  if ((await csvLink.count()) > 0) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 5000 }),
        csvLink.first().click()
      ]);
      const path = await download.path();
      if (path) {
        const fileBuffer = await readFile(path);
        // TODO(要確認): PeatixのCSVエンコード(Shift JIS想定だが未検証)。
        const text = decodeShiftJis(fileBuffer);
        const rows = tableFromCsv(text);
        const headers = rows[0] ? Object.keys(rows[0]) : [];
        const nameColumn = findColumn(headers, ["氏名", "お名前", "名前", "Name"]);
        if (nameColumn) {
          return rows.map((row) => String(row[nameColumn] || "").trim()).filter(Boolean);
        }
      }
    } catch {
      // ダウンロードが発生しなかった場合は画面表示のフォールバックへ。
    }
  }

  // フォールバック: 画面上に表示されている購入者名を拾う。
  // TODO(要確認): 個々の参加者行の正確なセレクタ。ここでは大まかな推定。
  return page.evaluate(() => {
    const names = [];
    for (const el of document.querySelectorAll("li, tr")) {
      const text = (el.textContent || "").trim();
      const match = text.match(/^([^\d]{2,20}?)\s*\d+\s*x\s*/);
      if (match) names.push(match[1].trim());
    }
    return names;
  });
}

async function scrapeAccount(account) {
  return withBrowser(`peatix-${account.label}`, async (page) => {
    await login(page, account);
    const dashboardUrl = await getDashboardUrl(page);
    const events = await listEvents(page, dashboardUrl);

    const reservations = [];
    for (const event of events) {
      if (!event.applied) continue; // 申込み0件のイベントはスキップ
      const names = await scrapeEventAttendees(page, event.eventId);
      for (const reservationName of names) {
        reservations.push({ rawEventName: event.title || event.eventId, reservationName });
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
    const reservations = await scrapeAccount(account);
    for (const reservation of reservations) {
      rows.push({
        platform: "peatix",
        account: account.label,
        rawEventName: reservation.rawEventName,
        reservationName: reservation.reservationName,
        obtainedAt
      });
    }
  }
  return rows;
}
