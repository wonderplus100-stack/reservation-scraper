import fs from "node:fs";
import path from "node:path";

// whitekeyへの自動入力・リスト更新の実行スケジュール(ユーザー指定)。専用PCのタスクが5分おきに呼び出し、
// その時点で「実行すべき枠」があるイベントだけを対象にする。
//
//  1. 夜20時: 当日の分と、曜日ごとの範囲の予約を入れる
//       月〜木: 当日・翌日 / 金: 当日・翌日・翌々日 / 土: 当日・翌日 / 日: 当日・翌日
//  2. 当日の朝9時: 当日のイベントのリストを更新
//  3. 当日のイベントの開始30分前: そのイベントのリストを更新
//  4. 当日のイベントの開始5分前: そのイベントのリストを更新
//
// 各枠は、予定時刻から10分以内に1回だけ実行する(成功したら記録し、失敗したら次の5分おきの実行でやり直す)。
// すでに始まったイベントは対象にしない。
const GRACE_MINUTES = 10;
const NIGHT_HOUR = 20;
const MORNING_HOUR = 9;
// getDay(): 日0 月1 火2 水3 木4 金5 土6 → 夜20時に対象とする日数(当日を含む)
const NIGHT_DAYS = { 0: 2, 1: 2, 2: 2, 3: 2, 4: 2, 5: 3, 6: 2 };

const STAMP_PATH = path.resolve("data", "whitekey-slots.json");

export function eventStart(event, today) {
  const [h, m] = String(event.time).split(":").map(Number);
  let date = new Date(today.getFullYear(), Number(event.month) - 1, Number(event.day), h, m || 0);
  // 公式イベントは年を持たない。2か月以上前になる日付は来年の開催とみなす。
  if (date < new Date(today.getTime() - 60 * 86400000)) date = new Date(today.getFullYear() + 1, Number(event.month) - 1, Number(event.day), h, m || 0);
  return date;
}

const dayKey = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

export function readStamps() {
  try {
    return JSON.parse(fs.readFileSync(STAMP_PATH, "utf8"));
  } catch {
    return {};
  }
}

// 実行済みの枠を記録する(3日より古い記録は消す)。
export function writeStamps(stamps, keys, now) {
  const next = { ...stamps };
  for (const key of keys) next[key] = now.toISOString();
  const cutoff = now.getTime() - 3 * 86400000;
  for (const [key, at] of Object.entries(next)) if (new Date(at).getTime() < cutoff) delete next[key];
  fs.mkdirSync(path.dirname(STAMP_PATH), { recursive: true });
  fs.writeFileSync(STAMP_PATH, JSON.stringify(next, null, 1));
}

// いま実行すべき枠と、その対象イベントを返す。
// 返り値: { events: Set<canonicalEventId>, keys: string[](実行する枠の記録キー), slots: string[](表示用) }
export function dueSlots(official, now, stamps) {
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const events = new Set();
  const keys = [];
  const slots = [];
  const inWindow = (time) => now >= time && now < new Date(time.getTime() + GRACE_MINUTES * 60000);
  const notStarted = (e) => eventStart(e, now) > now;
  const dated = official.map((e) => ({ e, start: eventStart(e, now) }));

  // 当日のイベント
  const todays = dated.filter(({ start }) => dayKey(start) === dayKey(now)).map(({ e }) => e);

  // 夜20時: 曜日ごとの範囲
  const nightTime = new Date(today0.getTime() + NIGHT_HOUR * 3600000);
  const nightKey = `${dayKey(now)}-night`;
  if (inWindow(nightTime) && !stamps[nightKey]) {
    const horizon = new Date(today0.getTime() + NIGHT_DAYS[now.getDay()] * 86400000);
    const targets = dated.filter(({ start, e }) => start >= today0 && start < horizon && notStarted(e));
    targets.forEach(({ e }) => events.add(e.canonicalEventId));
    keys.push(nightKey);
    slots.push(`夜${NIGHT_HOUR}時(${NIGHT_DAYS[now.getDay()]}日分)`);
  }

  // 朝9時: 当日のイベント
  const morningTime = new Date(today0.getTime() + MORNING_HOUR * 3600000);
  const morningKey = `${dayKey(now)}-morning`;
  if (inWindow(morningTime) && !stamps[morningKey]) {
    todays.filter(notStarted).forEach((e) => events.add(e.canonicalEventId));
    keys.push(morningKey);
    slots.push(`朝${MORNING_HOUR}時`);
  }

  // 開始30分前・5分前: そのイベント
  for (const e of todays) {
    const start = eventStart(e, now);
    for (const [label, minutes] of [["30分前", 30], ["5分前", 5]]) {
      const key = `${dayKey(now)}-pre${minutes}-${e.canonicalEventId}`;
      if (inWindow(new Date(start.getTime() - minutes * 60000)) && notStarted(e) && !stamps[key]) {
        events.add(e.canonicalEventId);
        keys.push(key);
        slots.push(`${e.venue}${e.time}の${label}`);
      }
    }
  }
  return { events, keys, slots };
}
