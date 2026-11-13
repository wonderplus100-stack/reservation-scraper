import { reportSource } from "../lib/sourceStatus.mjs";
import { withBrowser } from "../lib/browser.mjs";

// Wonder+公式サイト(WordPress)の管理画面「予約 → 予約一覧」に溜まっている予約者を取得する。
// 公式サイト経由の予約は他の媒体と違い外部サービスを通らないため、管理画面の一覧を読む。
//
// 管理画面はログインが必要。Peatixと同じく専用のChromeプロファイルにユーザー自身が
// 1回ログインしておき(scripts/wp-manual-login.mjs)、以降の自動取得はその
// ログイン状態を使い回す。パスワードはこのプログラムでは扱わない。
//
// 一覧の列: 予約(#ID・タイトル) / ステータス(予約中・キャンセル済み) / イベント /
// 開催日時 / お客様 / 連絡先 / 人数 / 受付日。1ページ300件表示になっており、
// ゴミ箱は件数に含まれない。キャンセル済みは集計対象外(ユーザー指示)。
// 人数が2人以上の予約は、同行者ぶんも人数に数える(ユーザー指示)。
const SITE_ORIGIN = "https://wonderplus.ne.jp";
const LIST_PATH = "/wp-admin/edit.php?post_type=booking";
const PROFILE_LABEL = "wonderplus-site";
const CANCELLED_MARKER = "キャンセル";

export function accountsFromEnv() {
  if (process.env.WP_BOOKINGS_ENABLED !== "true") return [];
  return [{ label: process.env.WP_BOOKINGS_ACCOUNT_LABEL || "公式サイト予約" }];
}

// お客様名の先頭の「★」等の印は氏名ではないので外す。
function cleanName(value) {
  return String(value || "").replace(/^[\s★☆※]+/, "").replace(/\s+/g, " ").trim();
}

// 「[東京 / 新宿] Wonder+CafeBiz ...」+「2026-10-28 15:00-16:00」を、他の媒体と同じく
// 日付・会場・シリーズ名・時刻で公式イベントと突き合わせられる1行の文字列にする。
function composeEventName(eventText, whenText) {
  const when = String(whenText || "").match(/(\d{4})-(\d{2})-(\d{2})\s*(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?/);
  const date = when ? `${Number(when[2])}/${Number(when[3])}` : "";
  const time = when ? [when[4], when[5]].filter(Boolean).join("-") : "";
  return [date, String(eventText || "").replace(/\s+/g, " ").trim(), time].filter(Boolean).join(" ");
}

async function loginRequired(page) {
  return /wp-login\.php|[?&]redirect_to=|reauth=1/.test(page.url()) || (await page.locator("#loginform").count()) > 0;
}

// 「参加者名簿(受付用)」は読み取り専用の画面で、イベントごとに 予約番号 / お名前 /
// フリガナ / 人数 / チケット(「男性 ¥1,700」のように性別と金額) / ステータス が出る。
// whitekeyへの自動入力で、お客様自身が入力したフリガナ・性別・金額を使うために、
// これから開催されるイベントの分だけ読む(サイトのデータは一切変更しない)。
const ROSTER_URL = `${SITE_ORIGIN}/wp-admin/edit.php?post_type=booking&page=wonder-booking-roster`;
const ROSTER_LOOKAHEAD_DAYS = 150;

async function readRosters(page) {
  await page.goto(ROSTER_URL, { waitUntil: "domcontentloaded" });
  const options = await page.evaluate(() =>
    [...document.querySelectorAll("select[name=event_id] option")].map((o) => [o.value, o.text])
  );
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const limit = new Date(today.getTime() + ROSTER_LOOKAHEAD_DAYS * 86400000);
  const eventIds = options
    .filter(([value, label]) => {
      const m = label.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (value === "0" || !m) return false;
      const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return date >= today && date <= limit;
    })
    .map(([value]) => value);

  const byNumber = new Map();
  for (const eventId of eventIds) {
    await page.goto(`${ROSTER_URL}&event_id=${eventId}`, { waitUntil: "domcontentloaded" });
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll(".wrap table tbody tr")].map((tr) =>
        [...tr.children].map((td) => td.textContent.replace(/\s+/g, " ").trim())
      )
    );
    for (const [number, , reading, , ticket] of rows) {
      const key = String(number || "").replace(/^#/, "");
      if (key) byNumber.set(key, { reading: reading || "", ticket: ticket || "" });
    }
  }
  return byNumber;
}

async function readAllPages(page) {
  await page.goto(`${SITE_ORIGIN}${LIST_PATH}`, { waitUntil: "domcontentloaded" });
  if (await loginRequired(page)) {
    throw new Error("公式サイトの管理画面のセッションが切れています。再ログインしてください(scripts/wp-relogin.cmd)");
  }
  await page.waitForSelector("table.wp-list-table", { timeout: 60000 });

  const totalPages = await page.evaluate(() => {
    const el = document.querySelector(".tablenav .total-pages");
    return el ? Number(el.textContent.replace(/[^\d]/g, "")) || 1 : 1;
  });

  const rows = [];
  for (let paged = 1; paged <= totalPages; paged += 1) {
    // 1ページ300件のHTMLを返すため重い(1ページ10秒前後かかる)。ログイン状態を
    // 引き継ぐため、画面と同じ接続でfetchして一覧の表だけ読む。
    const pageRows = await page.evaluate(async (pageNumber) => {
      const res = await fetch(`/wp-admin/edit.php?post_type=booking&paged=${pageNumber}`, { credentials: "same-origin" });
      if (res.redirected && /wp-login/.test(res.url)) return { loginRequired: true, rows: [] };
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const text = (tr, column) => (tr.querySelector(`td.column-${column}`)?.textContent || "").replace(/\s+/g, " ").trim();
      const out = [];
      for (const tr of doc.querySelectorAll("table.wp-list-table tbody tr")) {
        if (!tr.querySelector("td.column-status")) continue;
        out.push({
          id: tr.id,
          number: ((tr.querySelector("a.row-title")?.textContent || "").trim().match(/^#(\d+)/) || [])[1] || "",
          status: text(tr, "status"),
          event: text(tr, "event"),
          when: (tr.querySelector("td.column-event_when")?.textContent || "").trim(),
          customer: text(tr, "customer"),
          attendees: text(tr, "attendees")
        });
      }
      return { loginRequired: false, rows: out };
    }, paged);
    if (pageRows.loginRequired) {
      throw new Error("公式サイトの管理画面のセッションが切れています。再ログインしてください(scripts/wp-relogin.cmd)");
    }
    rows.push(...pageRows.rows);
  }
  // 名簿の読み取りに失敗しても、予約の人数集計(従来の機能)は止めない。
  let rosters = new Map();
  try {
    rosters = await readRosters(page);
  } catch (err) {
    console.error(`wpBookings: 参加者名簿の読み取りに失敗しました(ふりがな・チケットなし): ${err.message}`);
  }
  return { rows, rosters };
}

export async function collect() {
  const accounts = accountsFromEnv();
  const rows = [];
  const obtainedAt = new Date().toISOString();

  for (const account of accounts) {
    let bookings;
    let rosters = new Map();
    try {
      ({ rows: bookings, rosters } = await withBrowser(PROFILE_LABEL, (page) => readAllPages(page), { persistent: true }));
    } catch (err) {
      console.error(`wpBookings(${account.label}) の取得に失敗しました:`, err.message);
      reportSource("wpBookings", account.label, { ok: false, message: err.message });
      continue;
    }

    const seen = new Set();
    for (const booking of bookings) {
      if (!booking.id || seen.has(booking.id)) continue; // ページ境界での重複読みを防ぐ
      seen.add(booking.id);
      if (booking.status.includes(CANCELLED_MARKER)) continue;
      const reservationName = cleanName(booking.customer);
      const rawEventName = composeEventName(booking.event, booking.when);
      if (!reservationName || !rawEventName) continue;
      const roster = rosters.get(booking.number) || { reading: "", ticket: "" };
      const gender = /女性/.test(roster.ticket) ? "女性" : /男性/.test(roster.ticket) ? "男性" : "";
      const detail = {
        readingKatakana: roster.reading,
        ticketName: roster.ticket,
        amount: (roster.ticket.match(/[¥￥]\s*([\d,]+)/) || [])[1]?.replace(/,/g, "") || "",
        genderHint: gender,
        bookingStatus: booking.status
      };
      rows.push({
        platform: "wpBookings", account: account.label, rawEventName, reservationName, obtainedAt,
        bookingKey: `wpBookings|${booking.number || booking.id}`,
        ...detail
      });
      // 人数が2人以上の予約は、同行者の氏名が分からないため「氏名(同行1)」のような
      // 仮の行を足して、予約人数ぶんが集計(氏名ごとのユニーク数)に入るようにする。
      const attendees = Math.min(Math.max(parseInt(booking.attendees, 10) || 1, 1), 20);
      for (let companion = 1; companion < attendees; companion += 1) {
        rows.push({
          platform: "wpBookings",
          account: account.label,
          rawEventName,
          reservationName: `${reservationName}(同行${companion})`,
          obtainedAt,
          bookingKey: `wpBookings|${booking.number || booking.id}|c${companion}`,
          ...detail
        });
      }
    }
    reportSource("wpBookings", account.label, { ok: true });
  }
  return rows;
}

// 開始直前の自動入力(scripts/whitekey-sync.mjs)用: 指定したイベント(WordPressの投稿ID)だけの
// 参加者名簿を、その場で読む。全件取得(約7分)と違い、1イベント数秒で済む。読み取り専用。
// events: [{ canonicalEventId, postId }]  返り値は RawData と同じ形の行(canonicalEventId 設定済み)。
export async function collectForEvents(events) {
  const [account] = accountsFromEnv();
  if (!account) throw new Error("公式サイト予約の取得が有効ではありません(WP_BOOKINGS_ENABLED=true)");
  const obtainedAt = new Date().toISOString();
  return withBrowser(PROFILE_LABEL, async (page) => {
    const rows = [];
    for (const { canonicalEventId, postId } of events) {
      await page.goto(`${ROSTER_URL}&event_id=${postId}`, { waitUntil: "domcontentloaded" });
      if (await loginRequired(page)) {
        throw new Error("公式サイトの管理画面のセッションが切れています。再ログインしてください(scripts/wp-relogin.cmd)");
      }
      const table = await page.evaluate(() =>
        [...document.querySelectorAll(".wrap table tbody tr")].map((tr) =>
          [...tr.children].map((td) => td.textContent.replace(/\s+/g, " ").trim())
        )
      );
      for (const [number, name, reading, attendeesText, ticket, , status] of table) {
        if (!number || !name || /キャンセル/.test(status || "")) continue;
        const reservationName = cleanName(name);
        const detail = {
          readingKatakana: reading || "",
          ticketName: ticket || "",
          amount: (String(ticket).match(/[¥￥]\s*([\d,]+)/) || [])[1]?.replace(/,/g, "") || "",
          genderHint: /女性/.test(ticket) ? "女性" : /男性/.test(ticket) ? "男性" : "",
          bookingStatus: status || ""
        };
        const key = String(number).replace(/^#/, "");
        const base = { platform: "wpBookings", account: account.label, canonicalEventId, obtainedAt, ...detail };
        rows.push({ ...base, reservationName, bookingKey: `wpBookings|${key}` });
        const attendees = Math.min(Math.max(parseInt(attendeesText, 10) || 1, 1), 20);
        for (let c = 1; c < attendees; c += 1) {
          rows.push({ ...base, reservationName: `${reservationName}(同行${c})`, bookingKey: `wpBookings|${key}|c${c}` });
        }
      }
    }
    return rows;
  }, { persistent: true });
}
