import "dotenv/config";
import { getVenueKey } from "../lib/venues.mjs";
import { parsePrices } from "../lib/eventPrices.mjs";
import {
  RAW_DATA_SHEET,
  readOfficialEvents,
  readEventMaster,
  readSheetAsObjects,
  replaceEventMasterRows,
  replaceOfficialEvents,
  replaceRawRows
} from "../lib/sheetsClient.mjs";

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

// OfficialEventsは毎回全件を作り直す(replaceOfficialEvents)ため、公式サイト
// 側の時刻表記の変化などでcanonicalEventIdの生成結果が変わると、既に
// EventMaster/RawDataに書き込み済みの古いIDがどのOfficialEvents行とも
// 一致しなくなり、該当する予約が「別イベント」として孤立してしまう
// (実際に、時刻部分を「開始〜終了」から「開始のみ」に変える変更をした際、
// 9/30 銀座 Wonder+CXOのPeatix・Googleフォーム予約が反映されなくなる
// 事故が発生した)。それを防ぐため、同期の都度、孤立したofficial-*行を
// 同じ月日+会場の現行イベントへ自動的に再マッピングする。
function slugifyForMatch(time) {
  return String(time || "").replace(/[^\d]/g, "");
}

async function reconcileStaleOfficialIds(sheetId, events) {
  const officialIdSet = new Set(events.map((e) => e.canonicalEventId));
  const byVenueDate = new Map();
  for (const e of events) {
    const key = `${e.month}|||${e.day}|||${e.venueKey}`;
    if (!byVenueDate.has(key)) byVenueDate.set(key, []);
    byVenueDate.get(key).push(e);
  }

  function resolveNewTarget(id) {
    const match = id.match(/^official-(\d{1,2})-(\d{1,2})-([^-]+)-(\d+)$/);
    if (!match) return null;
    const [, month, day, venueKey, oldTimeSlug] = match;
    const candidates = byVenueDate.get(`${month}|||${day}|||${venueKey}`) || [];
    if (candidates.length === 0) return null;
    const byTime = candidates.find((c) => oldTimeSlug.startsWith(slugifyForMatch(c.time)));
    return byTime || candidates[0];
  }

  const [eventMaster, rawData] = await Promise.all([
    readEventMaster(sheetId),
    readSheetAsObjects(sheetId, RAW_DATA_SHEET)
  ]);

  const orphanedIds = new Set();
  for (const row of eventMaster) {
    const id = String(row.canonicalEventId || "");
    if (id.startsWith("official-") && !officialIdSet.has(id)) orphanedIds.add(id);
  }
  for (const row of rawData) {
    const id = String(row.canonicalEventId || "");
    if (id.startsWith("official-") && !officialIdSet.has(id)) orphanedIds.add(id);
  }
  if (orphanedIds.size === 0) return;

  const idRemap = new Map();
  for (const id of orphanedIds) {
    const target = resolveNewTarget(id);
    if (target) idRemap.set(id, target);
  }
  if (idRemap.size === 0) return;

  let eventMasterChanged = 0;
  const updatedEventMaster = eventMaster.map((row) => {
    const target = idRemap.get(String(row.canonicalEventId || ""));
    if (!target) return row;
    eventMasterChanged += 1;
    return { ...row, canonicalEventId: target.canonicalEventId, canonicalEventName: target.canonicalEventName };
  });
  if (eventMasterChanged > 0) await replaceEventMasterRows(sheetId, updatedEventMaster);

  let rawChanged = 0;
  const updatedRawData = rawData.map((row) => {
    const target = idRemap.get(row.canonicalEventId);
    if (!target) return row;
    rawChanged += 1;
    return { ...row, canonicalEventId: target.canonicalEventId };
  });
  if (rawChanged > 0) await replaceRawRows(sheetId, updatedRawData);

  console.log(
    `孤立したEventMaster/RawDataの旧IDを再マッピングしました(EventMaster: ${eventMasterChanged}件, RawData: ${rawChanged}件)。`
  );
}

// 公式イベントページの「男性：￥2,500 女性：￥2,500」から、性別ごとの参加費を読み取って events に付ける。
// 媒体(イベマド・Googleフォーム等)に金額が無い予約の、金額の目安に使う。
// 前回までに読めた金額は引き継ぎ、まだ金額が無い「120日前以降」のイベントだけページを開く。
async function fillEventFees(sheetId, events) {
  let previous = [];
  try {
    previous = await readOfficialEvents(sheetId);
  } catch {
    // 初回などで読めなければ、全部読み直す
  }
  const feeById = new Map(previous.filter((p) => p.maleFee !== "" && p.maleFee !== undefined).map((p) => [String(p.canonicalEventId), p]));
  const recent = new Date();
  recent.setDate(recent.getDate() - 120);
  const targets = [];
  for (const event of events) {
    const old = feeById.get(event.canonicalEventId);
    if (old) {
      event.maleFee = old.maleFee;
      event.femaleFee = old.femaleFee;
    } else if (event.link && event.date >= recent) {
      targets.push(event);
    }
  }
  let filled = 0;
  for (let i = 0; i < targets.length; i += 8) {
    await Promise.all(
      targets.slice(i, i + 8).map(async (event) => {
        try {
          const res = await fetch(event.link);
          if (!res.ok) return;
          const prices = parsePrices(await res.text());
          if (prices) {
            event.maleFee = prices.male;
            event.femaleFee = prices.female;
            filled += 1;
          }
        } catch {
          // 読めないイベントは金額なしのまま(次回また試す)
        }
      })
    );
  }
  // 終了したイベントのページは参加費の表示が無いことがある。その場合は、同じ名前(日付を除く)の
  // 別の回の参加費を目安にする(ダッシュボードでは「約」付きの推定として表示される)。
  const seriesKey = (event) => String(event.canonicalEventName || "").replace(/^\d{1,2}\/\d{1,2}\s+/, "");
  const bySeries = new Map();
  for (const event of events) {
    if (event.maleFee !== undefined && event.maleFee !== "" && !bySeries.has(seriesKey(event))) bySeries.set(seriesKey(event), event);
  }
  let borrowed = 0;
  for (const event of events) {
    if (event.maleFee !== undefined && event.maleFee !== "") continue;
    const similar = bySeries.get(seriesKey(event));
    if (similar) {
      event.maleFee = similar.maleFee;
      event.femaleFee = similar.femaleFee;
      borrowed += 1;
    }
  }
  console.log(`参加費を読み取りました: ${filled}/${targets.length}件(引き継ぎ ${feeById.size}件、同じ名前の回から借用 ${borrowed}件)`);
}

async function main() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error("環境変数 SHEET_ID が設定されていません");

  const posts = await fetchAllEvents();

  const events = [];
  const eventDates = [];
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

    events.push({ canonicalEventId, canonicalEventName, month, day, venue: venueKey, venueKey, time, capacity: "", link, date: new Date(Number(year), month - 1, day) });
    eventDates.push(new Date(Number(year), month - 1, day));
  }

  // 毎週木曜20:00-21:00の「オンライン異業種交流会」は公式サイトのイベント一覧に
  // 載っていない(オンライン表記・オンライン会場のイベントは0件)が、Peatix・
  // Googleフォーム2では毎週の開催として予約を受けている(ユーザーに確認済み)。
  // 予約の受け皿になるよう、公式イベントの日付範囲内の木曜日分を補う。
  // 公式サイトが将来オンラインのイベントを載せ始めた場合は、重複を避けて補わない。
  if (eventDates.length > 0) {
    const first = new Date(Math.min(...eventDates));
    const last = new Date(Math.max(...eventDates));
    const hasOnlineOnSite = new Set(events.filter((e) => e.venueKey === "オンライン").map((e) => `${e.month}-${e.day}`));
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 4) continue;
      const month = d.getMonth() + 1;
      const day = d.getDate();
      if (hasOnlineOnSite.has(`${month}-${day}`)) continue;
      events.push({
        canonicalEventId: `official-${month}-${day}-オンライン-2000`,
        canonicalEventName: `${month}/${day} オンライン Wonder+Online オンライン異業種交流会 20:00`,
        month,
        day,
        venue: "オンライン",
        venueKey: "オンライン",
        time: "20:00",
        capacity: ""
      });
    }
  }

  if (skipped > 0) {
    console.warn(`URLパターンに一致せずスキップした投稿: ${skipped}件`);
  }

  await fillEventFees(sheetId, events);
  await replaceOfficialEvents(sheetId, events);
  console.log(`OfficialEventsをWonder+公式サイトの${events.length}件で更新しました。`);

  await reconcileStaleOfficialIds(sheetId, events);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
