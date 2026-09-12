import { readFile } from "node:fs/promises";
import { submitForm, withBrowser } from "../lib/browser.mjs";
import { generateTotpCode } from "../lib/totp.mjs";
import { decodeShiftJis, findColumn, tableFromCsv } from "../lib/csv.mjs";

const LOGIN_URL = "https://www.kokuchpro.com/auth/login/";
// 「募集中イベント」「終了イベント」の両方を対象にする(終了済みの回にも参加者は残る)。
// 実アカウントで確認したところ、フィルタ無しだと募集中45件+終了236件=
// 281件を毎回全走査しており(1件ずつ管理画面を開くため)、これが
// タイムアウトの主因だった。entry=1(申込ありのイベント)で絞り込むと
// 45件+82件=127件のうち実際に処理が必要なのは82+1=83件まで減らせる。
const EVENT_LIST_URLS = [
  "https://www.kokuchpro.com/mypage/event/?entry=1&filter_sort=1",
  "https://www.kokuchpro.com/mypage/event/close/?entry=1&filter_sort=1"
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
    // Node(undici)の"fetch failed"は上位ラッパーのメッセージで、実際の
    // 原因(DNS解決失敗/接続拒否/TLSエラー等)はe.causeに入っている。
    console.error(`[kokuchpro診断] fetchも失敗: ${e.message} cause=${e.cause?.code || e.cause?.message || e.cause}`);
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

// 1ページ20件で複数ページに分かれるため(実アカウントで最大5ページ確認済み)、
// 新しい行が取れなくなるまで(または安全のため上限20ページまで)辿る。
const MAX_LIST_PAGES = 20;

// イベント一覧ページから、各イベントの管理画面URL(最初の開催日)を集める。
// 重要: 定期開催イベントは同じe-ハッシュ(イベント本体)が開催日の数だけ
// 一覧に別行(別d-id)で表示される。1つのd-idにアクセスするだけで
// そのイベントの全開催日(dropdown)が分かるため、e-ハッシュ単位で
// 重複除去しないと、同じイベントの全開催回を行の数だけ重複して
// 処理してしまう(実測で1イベント最大48開催回、これが数時間規模の
// 処理時間になっていた主因)。ページネーション終了判定は生URL単位
// (重複除去前)で行う、でないと1ページが同一イベントの複数行だけで
// 埋まった場合に「新しいイベントなし」と誤判定して途中で打ち切って
// しまう。
async function listEventAdminUrls(page) {
  const rawUrls = new Set();
  for (const listUrl of EVENT_LIST_URLS) {
    for (let pageNum = 1; pageNum <= MAX_LIST_PAGES; pageNum += 1) {
      const url = pageNum === 1 ? listUrl : `${listUrl}&page=${pageNum}`;
      // ログインページ同様、広告読み込みで"load"イベントが遅延するため
      // domcontentloadedで次に進む(これが未対応だったため、goto()が
      // それぞれ最大60秒粘り、外側のタイムアウトを診断ログなしで
      // 消費してしまっていたと考えられる)。
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const hrefs = await page.locator('a[href*="/admin/e-"]').evaluateAll((els) => els.map((el) => el.href));
      const before = rawUrls.size;
      for (const href of hrefs) rawUrls.add(href.split("?")[0]);
      if (rawUrls.size === before) break; // これ以上新しい行が無ければ次ページは無い
    }
  }

  const byHash = new Map();
  for (const url of rawUrls) {
    const match = url.match(EVENT_ADMIN_URL_RE);
    if (!match) continue;
    const [, eventHash] = match;
    if (!byHash.has(eventHash)) byHash.set(eventHash, url);
  }
  return Array.from(byHash.values());
}

// イベント管理画面の開催日セレクトボックスを1つずつ選び、
// 各開催日に対応する d-ID とラベル(日時)を集める。
async function listSessions(page, eventAdminUrl) {
  await page.goto(eventAdminUrl, { waitUntil: "domcontentloaded" });
  const select = page.locator("select").first();
  const optionCount = await select.locator("option").count();
  const sessions = [];
  const seen = new Set();

  for (let i = 0; i < optionCount; i += 1) {
    const optionLocator = select.locator("option").nth(i);
    const label = (await optionLocator.textContent())?.trim() || "";
    if (!label || label.includes("開催日の追加") || /^-+$/.test(label)) continue;

    await select.selectOption({ index: i });
    // submitForm/一覧ページと同じ問題: 広告読み込みのせいでnetworkidleが
    // 成立せず、開催回数(セッション)が多いイベントで1回あたり最大60秒
    // 粘ってしまい、1件のイベントだけで外側のタイムアウトを使い切って
    // いた(実測で確認)。ここで本当に必要なのは「URLが開催日ごとの
    // 管理画面に変わったこと」だけなので、load-state系ではなく
    // waitForURLで直接それを待つ(domcontentloadedだと遷移開始前に
    // 呼んでしまい即座に解決してしまう競合の恐れがあるため)。
    await page.waitForURL(EVENT_ADMIN_URL_RE, { timeout: 15000 }).catch(() => {});
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
  await page.goto(`https://www.kokuchpro.com/admin/participant/e-${eventHash}/d-${dateId}/`, {
    waitUntil: "domcontentloaded"
  });

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
  // 実アカウントのCSVで確認済み: 実際の列名は「申込者名」
  // (申込番号, 申込状態, 申込者名, メールアドレス, ...)。
  const nameColumn = findColumn(headers, ["申込者名", "氏名", "お名前", "名前"]);
  if (!nameColumn) {
    console.warn(`こくちーずPRO: 氏名列が見つかりません(見つかった列: ${headers.join(", ")})`);
    return [];
  }
  return rows.map((row) => String(row[nameColumn] || "").trim()).filter(Boolean);
}

async function scrapeAccount(account) {
  return withBrowser(`kokuchpro-${account.label}`, async (page) => {
    await login(page, account);
    console.error("[kokuchpro診断] ログイン成功");

    const eventAdminUrls = await listEventAdminUrls(page);
    console.error(`[kokuchpro診断] イベント管理画面URL件数: ${eventAdminUrls.length}`);
    const reservations = [];

    for (const [index, eventAdminUrl] of eventAdminUrls.entries()) {
      const sessions = await listSessions(page, eventAdminUrl);
      await page.goto(eventAdminUrl, { waitUntil: "domcontentloaded" });
      const eventTitle = await getEventTitle(page);
      console.error(`[kokuchpro診断] イベント処理中(${index + 1}/${eventAdminUrls.length}): ${eventTitle} (開催回数: ${sessions.length})`);

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
