import { submitForm, withBrowser } from "../lib/browser.mjs";
import { generateTotpCode } from "../lib/totp.mjs";

const LOGIN_URL = "https://tunagate.com/users/sign_in";
const MANAGEMENT_URL = "https://tunagate.com/mypage/management";

// 重要な制約(実アカウントで確認済み):
// つなげーとの参加者は「本名非公開設定」にしている場合、氏名の代わりに
// @ハンドル名(例: @z6EpIt)しか取得できない。この場合、他媒体(こくちーずPRO/
// Peatix/Googleフォーム)の氏名とは名寄せできない。氏名が非公開でない参加者は
// familyname/firstnameに本名が入る。

function accountsFromEnv() {
  const accounts = [];
  const email = process.env.TUNAGATE_1_EMAIL;
  const password = process.env.TUNAGATE_1_PASSWORD;
  if (email && password) {
    accounts.push({
      label: process.env.TUNAGATE_1_ACCOUNT_LABEL || "つなげーと",
      email,
      password,
      totpSecret: process.env.TUNAGATE_1_TOTP_SECRET || ""
    });
  }
  return accounts;
}

// つなげーとのログインは「メール入力→ログインボタン→(次のステップで)パスワード入力」
// の2段階(実アカウントで確認済み)。
async function login(page, account) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("your@email.com").fill(account.email);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.getByRole("button", { name: "ログイン" }).click()
  ]);

  const passwordInput = page.locator('input[type="password"]');
  await passwordInput.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  if ((await passwordInput.count()) > 0) {
    await passwordInput.fill(account.password);
    await submitForm(page, passwordInput);
  }

  if (account.totpSecret) {
    // TODO(要確認): つなげーとの2段階認証コード入力欄のセレクタ。
    const totpInput = page.locator('input[name="otp"], input[name="code"], input[autocomplete="one-time-code"]');
    if ((await totpInput.count()) > 0) {
      await totpInput.first().fill(generateTotpCode(account.totpSecret));
      await page.keyboard.press("Enter");
      await page.waitForLoadState("networkidle").catch(() => {});
    }
  }
}

// 「サークル・アカウント管理」ページから、管理しているサークルIDを集める。
async function listCircleIds(page) {
  await page.goto(MANAGEMENT_URL);
  const hrefs = await page.locator('a[href^="/circle/"]').evaluateAll((els) =>
    els.map((el) => el.getAttribute("href")).filter((href) => /^\/circle\/\d+$/.test(href || ""))
  );
  return Array.from(new Set(hrefs.map((href) => href.split("/")[2])));
}

// サークルのイベント一覧から、開催イベントIDを集める。
// TODO(要実装): 表示件数が多いサークルは無限スクロールで追加読み込みが
// 必要になる可能性がある(このアカウントでは初期表示で29件確認できた)。
async function listEventIds(page, circleId) {
  await page.goto(`https://tunagate.com/circle/${circleId}/events`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const hrefs = await page.evaluate((cid) => {
    const prefix = `/circle/${cid}/events/`;
    return Array.from(document.querySelectorAll(`a[href^="${prefix}"]`))
      .map((a) => a.getAttribute("href"))
      .filter((href) => href !== `/circle/${cid}/events`);
  }, circleId);
  return Array.from(new Set(hrefs.map((href) => href.split("/").pop())));
}

async function getEventTitle(page) {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('nav[aria-label="breadcrumb"] li'));
    const last = items[items.length - 1];
    const prev = items[items.length - 2];
    if (last && last.textContent.trim() === "イベント参加者" && prev) {
      return prev.textContent.trim();
    }
    return document.title;
  });
}

// 参加者一覧ページのDOMに埋め込まれたReactコンポーネントのprops(JSON)から、
// 実際の参加者(お気に入り登録者は含まない)を取得する。
// テキストの見た目に依存しないため、画面デザイン変更に強い。
async function scrapeParticipants(page, eventId) {
  await page.goto(`https://tunagate.com/event/${eventId}/participants`);
  await page.waitForLoadState("networkidle").catch(() => {});

  const eventTitle = await getEventTitle(page);
  const participants = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-react-class*="update_event_participation_user"]'))
      .map((el) => {
        try {
          return JSON.parse(el.getAttribute("data-react-props"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .map((props) => props.eventsPlansUser)
      .filter((epu) => !epu.canceled_at); // キャンセル済みは除外
  });

  return participants.map((epu) => {
    const user = epu.user;
    const reservationName = user.is_fullname_hidden
      ? `@${user.tunagate_id}`
      : `${user.familyname || ""}${user.firstname || ""}`.trim() || `@${user.tunagate_id}`;
    return { rawEventName: eventTitle, reservationName };
  });
}

async function scrapeAccount(account) {
  return withBrowser(`tunagate-${account.label}`, async (page) => {
    await login(page, account);

    const circleIds = await listCircleIds(page);
    const reservations = [];
    for (const circleId of circleIds) {
      const eventIds = await listEventIds(page, circleId);
      for (const eventId of eventIds) {
        const participants = await scrapeParticipants(page, eventId);
        reservations.push(...participants);
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
        platform: "tunagate",
        account: account.label,
        rawEventName: reservation.rawEventName,
        reservationName: reservation.reservationName,
        obtainedAt
      });
    }
  }
  return rows;
}
