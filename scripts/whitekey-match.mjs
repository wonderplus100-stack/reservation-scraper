import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { openPartyList, openWhitekey, readParties, showDate } from "../lib/whitekeyClient.mjs";

// 入力予定(data/whitekey-plan.json)の各予約を、whitekey側のどのパーティーに入れるかを突き合わせる。
// 日付 + 都市 + 開始時刻 で探す。whitekeyの一覧画面を読むだけで、何も変更しない
// (「受付」ボタンは押さない)。結果は data/whitekey-match.json と画面の要約に出す。
//
// 使い方: node scripts/whitekey-match.mjs   (先に node scripts/whitekey-plan.mjs で一覧を作る)
const CITY_WORDS = [
  ["銀座", ["銀座", "有楽町"]],
  ["新宿", ["新宿"]],
  ["大阪", ["梅田", "大阪"]],
  ["名古屋", ["名駅", "名古屋"]],
  ["札幌", ["札幌"]],
  ["神戸", ["神戸"]],
  ["京都", ["京都"]],
  ["横浜", ["横浜"]],
  ["福岡", ["福岡", "博多"]],
  ["熊本", ["熊本"]],
  ["仙台", ["仙台"]],
  ["船橋", ["船橋"]],
  ["宇都宮", ["宇都宮"]],
  ["岡山", ["岡山"]],
  ["広島", ["広島"]]
];

function cityOfHall(hall) {
  const hit = CITY_WORDS.find(([, words]) => words.some((w) => hall.includes(w)));
  return hit ? hit[0] : "";
}

function startTime(text) {
  const m = String(text).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}

function entryDate(entry, today) {
  let date = new Date(today.getFullYear(), Number(entry.month) - 1, Number(entry.day));
  if (date < today) date = new Date(today.getFullYear() + 1, Number(entry.month) - 1, Number(entry.day));
  return date;
}

const ymd = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;

async function main() {
  const planPath = path.resolve("data", "whitekey-plan.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dates = [...new Set(plan.map((e) => ymd(entryDate(e, today))))].sort();
  const wk = await openWhitekey();
  const partiesByDate = new Map();
  try {
    await openPartyList(wk.page);
    for (const date of dates) {
      await showDate(wk.page, date);
      const parties = (await readParties(wk.page)).map((p) => ({ ...p, city: cityOfHall(p.hall), start: startTime(p.time) }));
      partiesByDate.set(date, parties);
    }
  } finally {
    await wk.close();
  }

  const results = plan.map((entry) => {
    const date = ymd(entryDate(entry, today));
    // whitekeyには婚活パーティーやホワイトマリッジの相談会も並ぶため、タイトルに「Wonder+」を
    // 含むもの(=Wonder+の交流会)だけを対象にする。同じ都市・時刻に複数ある場合は、
    // 公式イベント名のシリーズ名(Business・Gravity・EveningUP など)でさらに絞る。
    let candidates = (partiesByDate.get(date) || []).filter(
      (p) => p.city === entry.venue && p.start === startTime(entry.time) && p.hasReceptionButton && !p.hall.includes("ホワイトマリッジ")
    );
    if (candidates.length > 1) {
      const wonder = candidates.filter((p) => /Wonder[+＋]/i.test(p.title));
      if (wonder.length >= 1) candidates = wonder;
    }
    if (candidates.length > 1) {
      const series = (entry.eventName.match(/Wonder[+＋]\s*([A-Za-z0-9]+)/i) || [])[1]?.toLowerCase();
      const narrowed = series ? candidates.filter((p) => p.title.toLowerCase().includes(series)) : [];
      if (narrowed.length >= 1) candidates = narrowed;
    }
    return {
      bookingKey: entry.bookingKey,
      date,
      venue: entry.venue,
      time: entry.time,
      eventName: entry.eventName,
      partycode: candidates.length === 1 ? candidates[0].partycode : "",
      matchState: candidates.length === 1 ? "一致" : candidates.length === 0 ? "whitekeyにパーティーなし" : "候補が複数",
      candidates: candidates.map((c) => `${c.hall} ${c.time} ${c.partycode}`)
    };
  });
  fs.writeFileSync(path.resolve("data", "whitekey-match.json"), JSON.stringify(results, null, 1));

  const byState = {};
  results.forEach((r) => { byState[r.matchState] = (byState[r.matchState] || 0) + 1; });
  console.log(`突き合わせ結果(${results.length}件): ${JSON.stringify(byState)}`);
  const missing = new Map();
  for (const r of results.filter((x) => x.matchState !== "一致")) {
    const key = `${r.date} ${r.venue} ${r.time} [${r.matchState}]`;
    missing.set(key, (missing.get(key) || 0) + 1);
  }
  console.log("一致しなかったパーティー(日付 都市 時刻 [理由]: 予約件数):");
  for (const [key, count] of [...missing.entries()].sort()) console.log(`  ${key}: ${count}件`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
