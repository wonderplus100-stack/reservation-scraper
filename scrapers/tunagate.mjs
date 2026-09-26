import { withBrowser } from "../lib/browser.mjs";

// 重要な制約(実アカウントで確認済み):
// つなげーとの参加者は「本名非公開設定」にしている場合、氏名の代わりに
// @ハンドル名(例: @z6EpIt)しか取得できない。この場合、他媒体(こくちーずPRO/
// Peatix/Googleフォーム)の氏名とは名寄せできない。氏名が非公開でない参加者は
// familyname/firstnameに本名が入る。
//
// 2026年9月に画面確認したところ、つなげーとはパスワードログインを廃止し
// 「メールアドレスのみ+認証メール」方式に変わっていた(Peatixと同様、
// 自動化ではメール確認を突破できない)。そのためパスワードは使わず、
// 保存済みセッション(storage-state、scripts/tunagate-manual-login.mjsで
// 手元PCから手動ログインして作成)を使い回す方式にした。

function accountsFromEnv() {
  const accounts = [];
  const email = process.env.TUNAGATE_1_EMAIL;
  if (!email) return accounts;
  accounts.push({
    label: process.env.TUNAGATE_1_ACCOUNT_LABEL || "つなげーと"
  });
  return accounts;
}

// 実際に確認したところ /mypage/management は404になっており、リダイレクトも
// 発生しないため「/users/sign_in にリダイレクトされないこと」では未ログイン
// を検知できなかった(常に「ログイン済み」と誤判定していた)。トップページに
// 「ログイン」リンクが残っているかどうかで判定する(manual-login.mjsと同じ方式)。
async function checkLoggedIn(page) {
  await page.goto("https://tunagate.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  console.error(`[つなげーと診断] checkLoggedIn url=${page.url()}`);
  const hasLoginLink = await page
    .locator('a[href*="/users/sign_in"]')
    .first()
    .isVisible()
    .catch(() => false);
  return !hasLoginLink;
}

// 「サークル・アカウント管理」ページから、管理しているサークルIDを集める。
async function listCircleIds(page) {
  const hrefs = await page.locator('a[href^="/circle/"]').evaluateAll((els) =>
    els.map((el) => el.getAttribute("href")).filter((href) => /^\/circle\/\d+$/.test(href || ""))
  );
  console.error(`[つなげーと診断] circleId候補=${JSON.stringify(hrefs)}`);
  if (hrefs.length === 0) {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => "");
    console.error(`[つなげーと診断] bodyText=${JSON.stringify(bodyText)}`);
  }
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
  return withBrowser(`tunagate-${account.label}`, async (page, { hasSavedState }) => {
    const loggedIn = hasSavedState && (await checkLoggedIn(page));
    if (!loggedIn) {
      throw new Error(
        `つなげーと(${account.label}): 保存済みセッションが無効です。手動で認証メールを使って再ログインしてください(node scripts/tunagate-manual-login.mjs "${account.label}")。`
      );
    }

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
    let reservations = [];
    try {
      reservations = await scrapeAccount(account);
    } catch (err) {
      console.error(`tunagate(${account.label}) の取得に失敗しました:`, err.message);
      continue;
    }
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
