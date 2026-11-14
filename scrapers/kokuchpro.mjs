import { reportSource } from "../lib/sourceStatus.mjs";
import { readFile } from "node:fs/promises";
import { submitForm, withBrowser } from "../lib/browser.mjs";
import { generateTotpCode } from "../lib/totp.mjs";
import { decodeShiftJis, findColumn, tableFromCsv } from "../lib/csv.mjs";
import { isTooOld, parseJaDate } from "../lib/fetchState.mjs";

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
  // KOKUCHPRO_1〜5 のうち、メールとパスワードが設定されているものを対象にする。
  // アカウントを増やすときは .env(とGitHubのVariables/Secrets)に番号を進めて追記するだけでよい。
  for (const index of [1, 2, 3, 4, 5]) {
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

  // storage-stateキャッシュ経由で既にログイン済みだと、/auth/login/への
  // アクセスは(ログインフォームを出さずに)/mypage/index/等へ即座に
  // リダイレクトされる。この状態で存在しないログインフォームを
  // fill()しようとして毎回タイムアウトしていたことが実測で判明したため、
  // ログインページ以外に遷移していれば既にログイン済みとみなして
  // フォーム操作をスキップする。
  if (!page.url().includes("/auth/login/")) {
    console.error(`[kokuchpro診断] 既にログイン済みのため、フォーム操作をスキップ: url=${page.url()}`);
    return;
  }

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

// 1ページ20件で複数ページに分かれるため、新しい行が取れなくなるまで(または安全のため上限まで)辿る。
const MAX_LIST_PAGES = 60;

// イベント一覧(募集中・終了)から、「開催日ごとの行」(e-ハッシュ + d-ID + タイトル + 開催日)を集める。
// 一覧には、定期開催イベントの開催日ごとに別の行(別のd-ID)が並ぶ。以前は、イベントの管理画面で開催日を
// 1つずつ選択して画面を切り替え、d-IDを調べていたため、1イベントに十数秒かかっていた(2アカウント目を
// 足したところ、全体で18分を超えた)。一覧の行から直接d-IDが分かるので、その選択の操作は不要。
async function listSessionRows(page) {
  const rowsByKey = new Map();
  for (const [listIndex, listUrl] of EVENT_LIST_URLS.entries()) {
    const closed = listUrl.includes("/close/");
    for (let pageNum = 1; pageNum <= MAX_LIST_PAGES; pageNum += 1) {
      const url = pageNum === 1 ? listUrl : `${listUrl}&page=${pageNum}`;
      // 広告読み込みで"load"イベントが遅延するため、domcontentloadedで次に進む。
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const found = await page.evaluate(() => {
        const idsOf = (href) => {
          const m = href.match(/\/admin\/e-([0-9a-f]+)\/d-(\d+)\//);
          return m ? { hash: m[1], dateId: m[2] } : null;
        };
        const distinctDates = (el) => new Set([...el.querySelectorAll('a[href*="/admin/e-"]')].map((x) => (idsOf(x.href) || {}).dateId)).size;
        return [...document.querySelectorAll('a[href*="/admin/e-"]')]
          .map((a) => {
            const ids = idsOf(a.href);
            if (!ids) return null;
            // この開催日の行だけ(他の開催日のリンクを含まない最大の親要素)の文言
            let row = a;
            while (row.parentElement && distinctDates(row.parentElement) === 1) row = row.parentElement;
            return { ...ids, text: row.innerText.replace(/\s+/g, " ").trim().slice(0, 500) };
          })
          .filter(Boolean);
      });
      const before = rowsByKey.size;
      for (const { hash, dateId, text } of found) {
        const key = `${hash}/${dateId}`;
        if (rowsByKey.has(key)) continue;
        const dateIndex = text.indexOf("開催日");
        const dateMatch = text.slice(dateIndex).match(/(\d{4}年\d{1,2}月\d{1,2}日[^ ]*\s*\d{1,2}:\d{2}[〜~-]\d{1,2}:\d{2})/);
        const dateLabel = dateMatch ? dateMatch[1] : "";
        const title = text.slice(0, dateIndex).replace(/^注目\s*/, "").trim();
        rowsByKey.set(key, { eventHash: hash, dateId, title, dateLabel, date: parseJaDate(dateLabel || text.slice(dateIndex)), closed });
      }
      if (rowsByKey.size === before) break; // これ以上新しい行が無ければ次ページは無い
    }
  }
  return Array.from(rowsByKey.values());
}

async function getEventTitle(page) {
  // Browserペインで実アカウントを直接確認したところ、単純な
  // a[href*="/event/"] だと最初に一致するのは「イベント管理」という
  // ナビゲーションリンク(href="https://www.kokuchpro.com/mypage/event/")
  // であり、実際のイベントタイトルではなかった(これがrawEventNameが
  // 常に「イベント管理｜(終了)日付...」になり、公式スケジュールとの
  // 日付+会場マッチングが全く成立しなかった原因)。実イベントタイトルへの
  // リンクは "/event/{ハッシュ}/{ID}/" 形式(/mypage/や/admin/を含まない、
  // 公開イベントページへのリンク)なので、それに絞り込む。
  const title = await page
    .locator('a[href^="https://www.kokuchpro.com/event/"]')
    .first()
    .textContent()
    .catch(() => null);
  return (title || "").trim();
}

// 参加者管理ページで「参加者名簿のダウンロード」ボタンを押し、CSVを取得して氏名を抽出する。
let diagnosedHeaders = false;

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
  // 自動入力(whitekey受付登録)に必要な付随情報。列名は実CSVに合わせて部分一致で探す。
  // 見つからない列は空のままにし、診断ログで実際の列名を確認できるようにする。
  const bookingNoColumn = findColumn(headers, ["申込番号", "受付番号"]);
  const statusColumn = findColumn(headers, ["申込状態", "ステータス", "状態"]);
  const ticketColumn = findColumn(headers, ["チケット名", "チケット", "参加区分", "参加種別"]);
  const amountColumn = findColumn(headers, ["参加費", "金額", "料金", "支払金額", "価格"]);
  const genderColumn = findColumn(headers, ["性別"]);
  const quantityColumn = findColumn(headers, ["枚数"]);
  if (!diagnosedHeaders) {
    diagnosedHeaders = true;
    console.error(`[kokuchpro診断] CSV列: ${headers.join(" / ")}`);
  }
  const cell = (row, column) => (column ? String(row[column] || "").trim() : "");
  return rows
    .map((row) => ({
      name: String(row[nameColumn] || "").trim(),
      bookingNo: cell(row, bookingNoColumn),
      status: cell(row, statusColumn),
      ticketName: cell(row, ticketColumn),
      amount: cell(row, amountColumn).replace(/[^\d]/g, ""),
      gender: cell(row, genderColumn),
      quantity: cell(row, quantityColumn).replace(/[^\d]/g, "")
    }))
    .filter((entry) => entry.name);
}


// こくちーずPROはGitHub Actionsからのアクセスで断続的な接続不調
// (page.goto自体の失敗/フォーム要素が時間内に現れない等、症状が
// 毎回異なる)が実測で確認されており、ロジック自体は正しくても
// 単発の実行では失敗することがある。ログインだけ数回リトライすることで
// この種の一過性の不調を吸収する。
async function loginWithRetry(page, account, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await login(page, account);
      return;
    } catch (err) {
      console.error(`[kokuchpro診断] ログイン試行${attempt}/${attempts}失敗: ${err.message}`);
      if (attempt === attempts) throw err;
    }
  }
}

// 名簿のダウンロードは、同じログイン状態の画面(タブ)を複数使って同時に行う。
const PARALLEL_PAGES = 4;

async function scrapeAccount(account) {
  return withBrowser(`kokuchpro-${account.label}`, async (page) => {
    await loginWithRetry(page, account);
    console.error("[kokuchpro診断] ログイン成功");

    const allRows = await listSessionRows(page);
    // 30日以上前の開催回は、名簿を取得しない(前回までのデータは、collect で引き継ぐ)。
    const sessions = allRows.filter((row) => !isTooOld(row.date));
    console.error(`[kokuchpro診断] 開催回: 一覧${allRows.length}件 → 取得対象${sessions.length}件(30日以上前の${allRows.length - sessions.length}件は取得しない)`);

    const reservations = [];
    // 今回、名簿を取得した開催回(「ハッシュ/開催ID」)。取得しなかった開催回の予約は、前回までのデータを引き継ぐ。
    const fetchedSessionIds = new Set();
    reservations.fetchedSessionIds = fetchedSessionIds;

    const context = page.context();
    const workers = [page, ...(await Promise.all(Array.from({ length: PARALLEL_PAGES - 1 }, () => context.newPage())))];
    const results = new Array(sessions.length);
    let next = 0;
    let done = 0;
    await Promise.all(
      workers.map(async (worker) => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= sessions.length) return;
          const session = sessions[index];
          results[index] = await downloadReservationNames(worker, session.eventHash, session.dateId);
          done += 1;
          if (done % 20 === 0) console.error(`[kokuchpro診断] 名簿取得 ${done}/${sessions.length}`);
        }
      })
    );

    sessions.forEach((session, index) => {
      fetchedSessionIds.add(`${session.eventHash}/${session.dateId}`);
      const label = `${session.closed ? "（終了）" : "（募集中）"}${session.dateLabel}`;
      for (const entry of results[index] || []) {
        reservations.push({
          rawEventName: `${session.title}｜${label}`,
          // 自動投稿ツールが記録する公開URL(/event/{ハッシュ}/{開催ID}/)と
          // 同じ「ハッシュ/開催ID」形式のキー。タイトルが変わっても不変。
          platformEventId: `${session.eventHash}/${session.dateId}`,
          reservationName: entry.name,
          // 同じ申込を二重に入力しないためのキー(申込番号が無い場合は氏名で代用)。
          bookingKey: `kokuchpro|${session.eventHash}/${session.dateId}|${entry.bookingNo || entry.name}`,
          bookingStatus: entry.status,
          ticketName: entry.ticketName,
          amount: entry.amount,
          genderHint: entry.gender,
          quantity: entry.quantity
        });
      }
    });
    return reservations;
  });
}

// アカウントごとの上限時間。1つのアカウントが遅くても、全体の上限(run.mjs)に達して
// 他のアカウントの取得結果まで失われないよう、全体より少し短く切る。
const ACCOUNT_TIMEOUT_MS = 18 * 60 * 1000;
function withAccountTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: ${ACCOUNT_TIMEOUT_MS / 60000}分以内に取得が終わりませんでした`)), ACCOUNT_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function collect(context = {}) {
  const accounts = accountsFromEnv();
  const obtainedAt = new Date().toISOString();
  const rows = [];

  // アカウントは同時に取得する。1アカウントに約10分かかるため、順番に取得すると、アカウントが増えた分だけ
  // 全体の上限時間(run.mjs の kokuchpro の上限)を超え、全アカウントのデータが失われてしまう
  // (2アカウント目を足した直後に実際に発生した)。失敗は、アカウントごとに分けて報告する。
  const results = await Promise.all(
    accounts.map(async (account) => {
      try {
        const reservations = await withAccountTimeout(scrapeAccount(account), account.label);
        reportSource("kokuchpro", account.label, { ok: true });
        return { account, reservations };
      } catch (err) {
        console.error(`kokuchpro(${account.label}) の取得に失敗しました:`, err.message);
        reportSource("kokuchpro", account.label, { ok: false, message: err.message });
        return { account, reservations: [] };
      }
    })
  );

  for (const { account, reservations } of results) {
    // 今回取得しなかった開催回(30日以上前など)の予約は、前回までのデータを引き継ぐ(消さない)。
    // 取得に成功したアカウントだけが対象(失敗したアカウントは、run.mjs が前回のデータをそのまま保持する)。
    if (reservations.fetchedSessionIds) {
      for (const row of context.existingRaw || []) {
        if (row.platform === "kokuchpro" && row.account === account.label && !reservations.fetchedSessionIds.has(String(row.platformEventId))) {
          rows.push(row);
        }
      }
    }
    for (const reservation of reservations) {
      rows.push({
        platform: "kokuchpro",
        account: account.label,
        rawEventName: reservation.rawEventName,
        platformEventId: reservation.platformEventId,
        reservationName: reservation.reservationName,
        bookingKey: reservation.bookingKey,
        bookingStatus: reservation.bookingStatus,
        ticketName: reservation.ticketName,
        amount: reservation.amount,
        genderHint: reservation.genderHint,
        quantity: reservation.quantity,
        obtainedAt
      });
    }
  }
  return rows;
}

// 開始直前の自動入力(scripts/whitekey-sync.mjs)用: 指定した「ハッシュ/開催ID」の参加者だけを、
// その場でこくちーずPROから取得する。イベントを持つアカウントが分からないため、見つかるまで
// 設定済みのアカウントを順に試す。返り値は RawData と同じ形の行(platformEventId 付き)。
export async function collectForPlatformEventIds(platformEventIds) {
  const accounts = accountsFromEnv();
  if (accounts.length === 0) throw new Error("こくちーずのログイン情報が .env にありません(KOKUCHPRO_1_PASSWORD 等)");
  const obtainedAt = new Date().toISOString();
  const rows = [];
  const found = new Set();
  for (const account of accounts) {
    const pending = platformEventIds.filter((id) => !found.has(id));
    if (pending.length === 0) break;
    await withBrowser(`kokuchpro-${account.label}`, async (page) => {
      await loginWithRetry(page, account);
      for (const id of pending) {
        const [eventHash, dateId] = id.split("/");
        const entries = await downloadReservationNames(page, eventHash, dateId);
        if (entries.length === 0) continue;
        found.add(id);
        for (const entry of entries) {
          rows.push({
            platform: "kokuchpro",
            account: account.label,
            platformEventId: id,
            reservationName: entry.name,
            bookingKey: `kokuchpro|${id}|${entry.bookingNo || entry.name}`,
            bookingStatus: entry.status,
            ticketName: entry.ticketName,
            amount: entry.amount,
            genderHint: entry.gender,
            quantity: entry.quantity,
            obtainedAt
          });
        }
      }
    });
  }
  return rows;
}
