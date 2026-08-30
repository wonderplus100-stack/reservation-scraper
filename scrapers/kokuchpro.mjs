import { readFile } from "node:fs/promises";
import { submitForm, withBrowser } from "../lib/browser.mjs";
import { generateTotpCode } from "../lib/totp.mjs";
import { decodeShiftJis, findColumn, tableFromCsv } from "../lib/csv.mjs";

const LOGIN_URL = "https://www.kokuchpro.com/auth/login/";
// 「募集中イベント」「終了イベント」の両方を対象にする(終了済みの回にも参加者は残る)。
const EVENT_LIST_URLS = [
  "https://www.kokuchpro.com/mypage/event/",
  "https://www.kokuchpro.com/mypage/event/close/"
];
const EVENT_ADMIN_URL_RE = /\/admin\/e-([0-9a-f]+)\/d-(\d+)\//;

function accountsFromEnv() {
  const accounts = [];
  // Phase 2: wonderplus100@gmail.com のみを対象にする(ユーザー指示)。
  // 2つ目のアカウントはPhase 5で有効化する。
  for (const index of [1]) {
    const email = process.env[`KOKUCHPRO_${index}_EMAIL`];
    const password = process.env[`KOKUCHPRO_${index}_PASSWORD`];
    if (!email || !password) continue;
    accounts.push({
      label: process.env[`KOKUCHPRO_${index}_ACCOUNT_LABEL`] || `こくちーずPRO${index}`,
      email,
      password,
      totpSecret: process.env[`KOKUCHPRO_${index}_TOTP_SECRET`] || ""
    });
  }
  return accounts;
}

// CI環境でpage.goto自体が60秒フルにタイムアウトする問題の原因切り分け用。
// Node側の生fetch(ブラウザを介さない)で同じURLに到達できるか確認する。
// これが成功するのにブラウザのgotoだけ失敗する場合、IP丸ごとブロックではなく
// ブラウザ/ヘッドレス検知(bot対策のJSチャレンジ等)が疑わしいと判断できる。
async function diagnoseNetwork(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const text = (await res.text()).slice(0, 300);
    console.error(`[kokuchpro診断] fetch成功 status=${res.status} body=${JSON.stringify(text)}`);
  } catch (e) {
    console.error(`[kokuchpro診断] fetchも失敗: ${e.message}`);
  }
}

async function login(page, account) {
  // 広告読み込みで"load"イベントが遅延することがあるため、
  // DOM構築完了時点(domcontentloaded)で次に進む。
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  } catch (err) {
    console.error(`[kokuchpro診断] page.goto失敗: url=${page.url()}`);
    await diagnoseNetwork(LOGIN_URL);
    throw err;
  }
  console.error(`[kokuchpro診断] page.goto成功: url=${page.url()}`);

  // fill()自体のtimeoutオプションだけに頼ると、ページが繰り返しリダイレクト/
  // 再読み込みするようなケースで想定より長く粘ってしまう可能性があるため、
  // Playwright側の時計とは独立したsetTimeoutで確実に45秒で打ち切り診断を出す。
  const formTask = (async () => {
    await page.locator('input[type="text"]').first().fill(account.email, { timeout: 40000 });
    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.fill(account.password, { timeout: 40000 });
    await submitForm(page, passwordInput);
  })();
  const hardDeadline = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("ログインフォーム操作が45秒で完了しなかった")), 45000)
  );
  try {
    await Promise.race([formTask, hardDeadline]);
  } catch (err) {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => "(取得失敗)");
    console.error(`[kokuchpro診断] ログインフォーム操作失敗: url=${page.url()} bodyText=${JSON.stringify(bodyText)}`);
    throw err;
  }

  if (account.totpSecret) {
    // TODO(要確認): 2段階認証コード入力欄のセレクタ。
    const totpInput = page.locator('input[name="otp"], input[name="code"], input[autocomplete="one-time-code"]');
    if ((await totpInput.count()) > 0) {
      await totpInput.first().fill(generateTotpCode(account.totpSecret));
      await page.keyboard.press("Enter");
      await page.waitForLoadState("networkidle").catch(() => {});
    }
  }
}

// イベント一覧ページから、各イベントの管理画面URL(最初の開催日)を集める。
async function listEventAdminUrls(page) {
  const urls = new Set();
  for (const listUrl of EVENT_LIST_URLS) {
    await page.goto(listUrl);
    const hrefs = await page.locator('a[href*="/admin/e-"]').evaluateAll((els) => els.map((el) => el.href));
    for (const href of hrefs) urls.add(href.split("?")[0]);
  }
  return Array.from(urls);
}

// イベント管理画面の開催日セレクトボックスを1つずつ選び、
// 各開催日に対応する d-ID とラベル(日時)を集める。
async function listSessions(page, eventAdminUrl) {
  await page.goto(eventAdminUrl);
  const select = page.locator("select").first();
  const optionCount = await select.locator("option").count();
  const sessions = [];
  const seen = new Set();

  for (let i = 0; i < optionCount; i += 1) {
    const optionLocator = select.locator("option").nth(i);
    const label = (await optionLocator.textContent())?.trim() || "";
    if (!label || label.includes("開催日の追加") || /^-+$/.test(label)) continue;

    await select.selectOption({ index: i });
    await page.waitForLoadState("networkidle").catch(() => {});
    const match = page.url().match(EVENT_ADMIN_URL_RE);
    if (!match) continue;
    const [, eventHash, dateId] = match;
    if (seen.has(dateId)) continue;
    seen.add(dateId);
    sessions.push({ eventHash, dateId, sessionLabel: label });
  }
  return sessions;
}

async function getEventTitle(page) {
  // TODO(要確認): タイトルの実際のセレクタ。イベント管理画面上部の見出しリンクを仮定している。
  const title = await page.locator('a[href*="/event/"]').first().textContent().catch(() => null);
  return (title || "").trim();
}

// 参加者管理ページで「参加者名簿のダウンロード」ボタンを押し、CSVを取得して氏名を抽出する。
async function downloadReservationNames(page, eventHash, dateId) {
  await page.goto(`https://www.kokuchpro.com/admin/participant/e-${eventHash}/d-${dateId}/`);

  const downloadButton = page.getByText("参加者名簿のダウンロード", { exact: false });
  if ((await downloadButton.count()) === 0) {
    // 申込みが0件の場合など、ボタン自体が表示されないことがある。
    return [];
  }

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    downloadButton.first().click()
  ]);
  const path = await download.path();
  if (!path) {
    console.warn("こくちーずPRO: CSVのダウンロードに失敗しました(一時ファイルが取得できません)");
    return [];
  }
  const fileBuffer = await readFile(path);

  const text = decodeShiftJis(fileBuffer);
  const rows = tableFromCsv(text);
  if (rows.length === 0) return [];

  const headers = Object.keys(rows[0]);
  // TODO(要確認): 実際のCSVヘッダー名。ヘルプセンターの説明からは列名が明記されていないため、
  // 「氏名」「お名前」「名前」のいずれかを含む列を氏名として扱う実装にしている。
  const nameColumn = findColumn(headers, ["氏名", "お名前", "名前"]);
  if (!nameColumn) {
    console.warn(`こくちーずPRO: 氏名列が見つかりません(見つかった列: ${headers.join(", ")})`);
    return [];
  }
  return rows.map((row) => String(row[nameColumn] || "").trim()).filter(Boolean);
}

async function scrapeAccount(account) {
  return withBrowser(`kokuchpro-${account.label}`, async (page) => {
    await login(page, account);

    const eventAdminUrls = await listEventAdminUrls(page);
    const reservations = [];

    for (const eventAdminUrl of eventAdminUrls) {
      const sessions = await listSessions(page, eventAdminUrl);
      await page.goto(eventAdminUrl);
      const eventTitle = await getEventTitle(page);

      for (const session of sessions) {
        const names = await downloadReservationNames(page, session.eventHash, session.dateId);
        for (const reservationName of names) {
          reservations.push({
            rawEventName: `${eventTitle}｜${session.sessionLabel}`,
            reservationName
          });
        }
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
        platform: "kokuchpro",
        account: account.label,
        rawEventName: reservation.rawEventName,
        reservationName: reservation.reservationName,
        obtainedAt
      });
    }
  }
  return rows;
}
