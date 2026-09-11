import { getVenueKey } from "./venues.mjs";

// 各媒体の生イベント名(自由記述)から、公式スケジュール(月/日/会場)の
// どのイベントに該当するかを推定する。完全一致ではなく、日付+会場の
// 組み合わせで突き合わせるベストエフォート方式。

// "6/22" "6月22日" のような表記から月日を取り出す。
function extractMonthDay(text) {
  const value = String(text || "");
  const slashMatch = value.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/);
  if (!slashMatch) return null;
  const month = Number(slashMatch[1]);
  const day = Number(slashMatch[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

// "19:30" のような開始時刻を取り出す(候補が複数ある場合の絞り込み用)。
function extractStartTime(text) {
  const match = String(text || "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

// rawEventNameを公式イベント一覧(officialEvents)と突き合わせ、
// 一致するものがあればそのエントリを返す(無ければnull)。
export function matchOfficialEvent(rawEventName, officialEvents) {
  const monthDay = extractMonthDay(rawEventName);
  if (!monthDay) return null;
  const venueKey = getVenueKey(rawEventName);
  if (!venueKey) return null;

  const candidates = officialEvents.filter(
    (event) => Number(event.month) === monthDay.month && Number(event.day) === monthDay.day && event.venueKey === venueKey
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // 同じ日・同じ会場で複数の開催回がある場合、開始時刻で絞り込む。
  const startTime = extractStartTime(rawEventName);
  if (startTime) {
    const byTime = candidates.find((event) => String(event.time || "").startsWith(startTime));
    if (byTime) return byTime;
  }
  return candidates[0];
}
