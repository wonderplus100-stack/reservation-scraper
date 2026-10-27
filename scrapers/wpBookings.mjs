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
  return rows;
}

export async function collect() {
  const accounts = accountsFromEnv();
  const rows = [];
  const obtainedAt = new Date().toISOString();

  for (const account of accounts) {
    let bookings;
    try {
      bookings = await withBrowser(PROFILE_LABEL, (page) => readAllPages(page), { persistent: true });
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
      rows.push({ platform: "wpBookings", account: account.label, rawEventName, reservationName, obtainedAt });
      // 人数が2人以上の予約は、同行者の氏名が分からないため「氏名(同行1)」のような
      // 仮の行を足して、予約人数ぶんが集計(氏名ごとのユニーク数)に入るようにする。
      const attendees = Math.min(Math.max(parseInt(booking.attendees, 10) || 1, 1), 20);
      for (let companion = 1; companion < attendees; companion += 1) {
        rows.push({
          platform: "wpBookings",
          account: account.label,
          rawEventName,
          reservationName: `${reservationName}(同行${companion})`,
          obtainedAt
        });
      }
    }
    reportSource("wpBookings", account.label, { ok: true });
  }
  return rows;
}
