import { getVenueKey } from "./venues.mjs";

// 公式サイトのイベントページ「料金 男性：￥2,500 女性：￥2,500」から、性別ごとの参加費を
// 読み取る。canonicalEventId の組み立ては scripts/sync-official-events.mjs と同じ
// (同じ日・会場・時刻が複数ある場合の連番の振り方も合わせる)。
const EVENT_TYPE_ENDPOINT = "https://wonderplus.ne.jp/wp-json/wp/v2/event";
const LINK_PATTERN = /\/events\/[^/]+\/([^/]+)\/[^/]+\/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\//;

async function fetchEventLinks() {
  const perPage = 100;
  const all = [];
  for (let page = 1; ; page += 1) {
    const res = await fetch(`${EVENT_TYPE_ENDPOINT}?per_page=${perPage}&page=${page}&_fields=id,link`);
    if (!res.ok) {
      if (page > 1) break;
      throw new Error(`公式サイトのREST APIエラー: ${res.status}`);
    }
    const rows = await res.json();
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < perPage) break;
  }
  return all;
}

export function parsePrices(html) {
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const toNumber = (match) => (match ? Number(match[1].replace(/,/g, "")) : null);
  const male = toNumber(text.match(/男性\s*[:：]\s*[¥￥]?\s*([\d,]+)/));
  const female = toNumber(text.match(/女性\s*[:：]\s*[¥￥]?\s*([\d,]+)/));
  if (male !== null || female !== null) return { male: male ?? female, female: female ?? male };
  const single = toNumber(text.match(/料金\s*[:：]?\s*[¥￥]\s*([\d,]+)/));
  return single === null ? null : { male: single, female: single };
}

// 引数 canonicalEventIds に含まれるイベントのページだけを取得して、
// Map(canonicalEventId → { male, female }) を返す。
export async function fetchEventPrices(canonicalEventIds) {
  const wanted = new Set(canonicalEventIds);
  const links = await fetchEventLinks();
  const seen = new Set();
  const targets = [];
  for (const post of links) {
    const match = String(post.link || "").match(LINK_PATTERN);
    if (!match) continue;
    const [, venueSlug, , monthStr, dayStr, hour, minute] = match;
    const month = Number(monthStr);
    const day = Number(dayStr);
    const venueKey = getVenueKey(venueSlug) || venueSlug;
    const base = `official-${month}-${day}-${venueKey}-${hour}${minute}`;
    let id = base;
    for (let suffix = 2; seen.has(id); suffix += 1) id = `${base}-${suffix}`;
    seen.add(id);
    if (wanted.has(id)) targets.push({ id, link: post.link });
  }

  const prices = new Map();
  for (const { id, link } of targets) {
    try {
      const res = await fetch(link);
      if (!res.ok) continue;
      const parsed = parsePrices(await res.text());
      if (parsed) prices.set(id, parsed);
    } catch {
      // 取得できないイベントは料金不明のまま(確認用一覧で「要確認」になる)
    }
  }
  return prices;
}
