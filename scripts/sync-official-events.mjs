import "dotenv/config";
import { getVenueKey } from "../lib/venues.mjs";
import { replaceOfficialEvents } from "../lib/sheetsClient.mjs";

// Wonder+公式サイト(https://wonderplus.ne.jp/)の「イベント」カスタム投稿
// タイプをWordPress REST APIから取得し、予約データの有無によらない
// 「本来あるべきイベント一覧」をOfficialEventsシートに書き出す。
// ダッシュボードのプルダウンはこのシートを正として表示する。
//
// 以前は手動更新の別スプレッドシート(公式スケジュール表)を情報源に
// していたが、Wonder+EveningUP・Wonder+WomensCafe等、実際には開催
// されている新しいシリーズのイベントがそのスプレッドシートには反映
// されておらず、予約データが恒常的に未マッピングになる不具合があった
// (ユーザー報告により発覚)。公式サイト自体を情報源にすることで、
// この手動更新の抜け漏れを構造的に無くす。
//
// 実アカウントで確認したところ、投稿詳細ページのパーマリンクに
// 「/events/{都道府県}/{会場}/{シリーズ}/{YYYYMMDD}-{HHMM}/」という
// 形で開催日・開始時刻・会場が構造化されて埋め込まれているため、
// 本文を解析せずにこのURLだけから確実に抽出できる。
const EVENT_TYPE_ENDPOINT = "https://wonderplus.ne.jp/wp-json/wp/v2/event";
const LINK_PATTERN = /\/events\/[^/]+\/([^/]+)\/[^/]+\/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\//;

function slugifyTime(time) {
  return String(time || "").replace(/[^\d]/g, "");
}

async function fetchAllEvents() {
  const perPage = 100;
  const all = [];
  for (let page = 1; ; page += 1) {
    const res = await fetch(`${EVENT_TYPE_ENDPOINT}?per_page=${perPage}&page=${page}&_fields=id,title,link`);
    if (!res.ok) {
      if (page > 1) break; // ページ範囲外(rest_post_invalid_page_number)
      throw new Error(`Wonder+公式サイトのREST APIエラー: ${res.status} ${res.statusText}`);
    }
    const rows = await res.json();
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < perPage) break;
  }
  return all;
}

async function main() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error("環境変数 SHEET_ID が設定されていません");

  const posts = await fetchAllEvents();

  const events = [];
  const seenIds = new Set();
  let skipped = 0;
  for (const post of posts) {
    const link = String(post.link || "");
    const match = link.match(LINK_PATTERN);
    if (!match) {
      skipped += 1;
      continue;
    }
    const [, venueSlug, year, monthStr, dayStr, hourStr, minuteStr] = match;
    const month = Number(monthStr);
    const day = Number(dayStr);
    const time = `${hourStr}:${minuteStr}`;
    const venueKey = getVenueKey(venueSlug) || venueSlug;
    // タイトル先頭の "[大阪] " "[東京 / 有楽町] " のような地域表示は、
    // canonicalEventName側で会場名を別途付与するため冗長になる。
    const eventName = String(post.title?.rendered || "").replace(/^[［\[][^\]］]*[\]］]\s*/, "").trim();

    let canonicalEventId = `official-${month}-${day}-${venueKey}-${slugifyTime(time)}`;
    let suffix = 2;
    while (seenIds.has(canonicalEventId)) {
      canonicalEventId = `official-${month}-${day}-${venueKey}-${slugifyTime(time)}-${suffix}`;
      suffix += 1;
    }
    seenIds.add(canonicalEventId);

    const canonicalEventName = [`${month}/${day}`, venueKey, eventName, time].filter(Boolean).join(" ");

    events.push({ canonicalEventId, canonicalEventName, month, day, venue: venueKey, venueKey, time, capacity: "" });
  }

  if (skipped > 0) {
    console.warn(`URLパターンに一致せずスキップした投稿: ${skipped}件`);
  }

  await replaceOfficialEvents(sheetId, events);
  console.log(`OfficialEventsをWonder+公式サイトの${events.length}件で更新しました。`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
